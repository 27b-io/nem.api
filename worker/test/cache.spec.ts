import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  boundaryTtl,
  buildCacheEntry,
  CLOSED_WINDOW_TTL_SECONDS,
  GENERATORS_TTL_SECONDS,
  INGEST_GRACE_SECONDS,
} from '../src/cache';
import { upsertValues } from '../src/ingest';
import worker from '../src/index';

// Same hour-aligned dispatch base as api.spec.ts — safely in the past, so
// absolute windows against it are "closed" and cache long.
const T0 = 1784901600;
// A boundary-aligned "now" for deterministic policy tests.
const NOW = T0 + 7 * 86400;

function entryFor(query: string, now = NOW, host = 'nem-api.test', path = '/api/v2/values') {
  return buildCacheEntry(new URL(`https://${host}${path}${query}`), now);
}

describe('boundaryTtl', () => {
  it('expires on the next dispatch boundary outside the ingest grace', () => {
    expect(boundaryTtl(NOW + 100)).toBe(200);
    expect(boundaryTtl(NOW + 299)).toBe(1);
  });

  it('within the grace window, expires at boundary+grace (pre-ingest fills get retried)', () => {
    expect(boundaryTtl(NOW)).toBe(INGEST_GRACE_SECONDS);
    expect(boundaryTtl(NOW + 30)).toBe(INGEST_GRACE_SECONDS - 30);
    expect(boundaryTtl(NOW + INGEST_GRACE_SECONDS)).toBe(300 - INGEST_GRACE_SECONDS);
  });
});

describe('buildCacheEntry — key canonicalisation', () => {
  it('collapses aliases onto the canonical name (no double-caching)', () => {
    expect(entryFor('?region=VIC1')!.key).toBe(entryFor('?state=VIC1')!.key);
    expect(entryFor('?fuel=Hydro')!.key).toBe(entryFor('?fuel_type=Hydro')!.key);
    expect(entryFor('?sort=time')!.key).toBe(entryFor('?order=time,asc')!.key);
  });

  it('canonical name wins over its alias, matching handler precedence', () => {
    expect(entryFor('?fuel=Hydro&fuel_type=Fossil')!.key).toBe(entryFor('?fuel=Hydro')!.key);
  });

  it('normalises time values: ISO and unix forms share a key', () => {
    const iso = encodeURIComponent(new Date(T0 * 1000).toISOString());
    expect(entryFor(`?time_start=${iso}&time_end=${T0 + 600}`)!.key).toBe(
      entryFor(`?time_start=${T0}&time_end=${T0 + 600}`)!.key,
    );
  });

  it('a relative window anchored to a start resolves to the same key as its absolute form', () => {
    expect(entryFor(`?time_start=${T0}&hours=2`)!.key).toBe(entryFor(`?time_start=${T0}&time_end=${T0 + 7200}`)!.key);
  });

  it('ignores unrecognised params — junk cannot bust the cache', () => {
    expect(entryFor(`?time_start=${T0}&junk=${crypto.randomUUID()}`)!.key).toBe(entryFor(`?time_start=${T0}`)!.key);
  });

  it('explicit resolution equal to the auto-pick shares the auto-pick key', () => {
    expect(entryFor(`?time_start=${T0}&time_end=${T0 + 600}&resolution=300`)!.key).toBe(
      entryFor(`?time_start=${T0}&time_end=${T0 + 600}`)!.key,
    );
  });

  it('sorts IN() lists (unordered semantics, one entry)', () => {
    expect(entryFor('?duid=BW01,BAPS')!.key).toBe(entryFor('?duid=BAPS,BW01')!.key);
  });

  it('keeps aggregate group_by verbatim: region and state are distinct echoed bodies', () => {
    const agg = (q: string) => entryFor(q, NOW, 'nem-api.test', '/api/v2/values/aggregate')!.key;
    expect(agg('?group_by=region')).not.toBe(agg('?group_by=state'));
  });

  it('now-derived windows keep their relative form: one key across intervals', () => {
    const a = entryFor('?hours=24', NOW + 10)!;
    const b = entryFor('?hours=24', NOW + 12345)!;
    expect(a.key).toBe(b.key);
    expect(entryFor('', NOW + 10)!.key).toBe(entryFor('', NOW + 9999)!.key); // 24 h default window
  });

  it('separates hosts, routes, and differing filters', () => {
    expect(entryFor('?region=VIC1')!.key).not.toBe(entryFor('?region=NSW1')!.key);
    expect(entryFor('?region=VIC1')!.key).not.toBe(entryFor('?region=VIC1', NOW, 'other.test')!.key);
    expect(entryFor('?region=VIC1')!.key).not.toBe(entryFor('?region=VIC1', NOW, 'nem-api.test', '/api/v2/generators')!.key);
  });

  it('returns null for unknown routes and malformed params (handler owns those)', () => {
    expect(entryFor('', NOW, 'nem-api.test', '/api/v2/nope')).toBeNull();
    expect(entryFor('?limit=lots')).toBeNull();
    expect(entryFor('?sort=scrape_time')).toBeNull();
    expect(entryFor('?time_start=not-a-date')).toBeNull();
  });
});

describe('buildCacheEntry — TTL policy', () => {
  it('fully-past windows cache long', () => {
    expect(entryFor(`?time_start=${T0}&time_end=${T0 + 600}`)!.ttl).toBe(CLOSED_WINDOW_TTL_SECONDS);
    expect(entryFor(`?time=${T0}`)!.ttl).toBe(CLOSED_WINDOW_TTL_SECONDS);
  });

  it('a window whose current interval can still gain samples never caches past the boundary', () => {
    // end lands in the just-finished interval, ingest grace not yet elapsed.
    const justEnded = entryFor(`?time_start=${NOW - 3600}&time_end=${NOW}`, NOW + 30)!;
    expect(justEnded.ttl).toBe(boundaryTtl(NOW + 30));
    // end in the future.
    expect(entryFor(`?time_start=${NOW - 3600}&time_end=${NOW + 3600}`, NOW + 100)!.ttl).toBe(boundaryTtl(NOW + 100));
    // open-ended and now-derived windows.
    expect(entryFor(`?time_start=${T0}`, NOW + 100)!.ttl).toBe(boundaryTtl(NOW + 100));
    expect(entryFor('?hours=24', NOW + 100)!.ttl).toBe(boundaryTtl(NOW + 100));
  });

  it('a closed window becomes long-cacheable exactly when its last interval clears the ingest grace', () => {
    const end = NOW - 300; // boundary-aligned upper bound
    expect(entryFor(`?time_start=${T0}&time_end=${end}`, end + INGEST_GRACE_SECONDS - 1)!.ttl).not.toBe(
      CLOSED_WINDOW_TTL_SECONDS,
    );
    expect(entryFor(`?time_start=${T0}&time_end=${end}`, end + INGEST_GRACE_SECONDS)!.ttl).toBe(CLOSED_WINDOW_TTL_SECONDS);
  });

  it('generators uses its fixed reference-data TTL', () => {
    expect(entryFor('', NOW, 'nem-api.test', '/api/v2/generators')!.ttl).toBe(GENERATORS_TTL_SECONDS);
  });
});

describe('handleApiCached — integration', () => {
  let host: string;
  let baps: number;

  async function get(path: string): Promise<Response> {
    return worker.fetch(new Request(`https://${host}${path}`), env);
  }

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM scada_values').run();
    host = `t-${crypto.randomUUID()}.test`;
    const row = await env.DB.prepare("SELECT MIN(id) AS id FROM generators WHERE duid = 'BAPS'").first<{ id: number }>();
    baps = row!.id;
  });

  it('MISS fills, alias-variant re-request HITs with an identical body', async () => {
    await upsertValues(env.DB, [{ scrapeTime: T0, generatorId: baps, value: 10 }]);
    const range = `time_start=${T0}&time_end=${T0 + 300}`;

    const miss = await get(`/api/v2/values?${range}&fuel=Hydro`);
    expect(miss.status).toBe(200);
    expect(miss.headers.get('x-cache')).toBe('MISS');
    expect(miss.headers.get('cache-control')).toBe(`public, max-age=${CLOSED_WINDOW_TTL_SECONDS}`);

    // Same canonical query through the alias — and D1 mutated in between, so
    // only a genuine cache hit can still return the original body.
    await env.DB.prepare('DELETE FROM scada_values').run();
    const hit = await get(`/api/v2/values?${range}&fuel_type=Hydro`);
    expect(hit.status).toBe(200);
    expect(hit.headers.get('x-cache')).toBe('HIT');
    expect(await hit.json()).toEqual(await miss.json());
    const maxAge = Number(/max-age=(\d+)/.exec(hit.headers.get('cache-control') ?? '')?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(CLOSED_WINDOW_TTL_SECONDS);
  });

  it('caches generators', async () => {
    const miss = await get('/api/v2/generators?duid=BAPS');
    expect(miss.headers.get('x-cache')).toBe('MISS');
    const hit = await get('/api/v2/generators?duid=BAPS');
    expect(hit.headers.get('x-cache')).toBe('HIT');
    expect(await hit.json()).toEqual(await miss.json());
  });

  it('never caches errors', async () => {
    for (let i = 0; i < 2; i++) {
      const res = await get('/api/v2/values?limit=lots');
      expect(res.status).toBe(400);
      expect(res.headers.get('x-cache')).toBeNull();
    }
    const notFound = await get('/api/v2/nope');
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('x-cache')).toBeNull();
  });

  it('keeps CORS headers on hits', async () => {
    await get('/api/v2/generators');
    const hit = await get('/api/v2/generators');
    expect(hit.headers.get('x-cache')).toBe('HIT');
    expect(hit.headers.get('access-control-allow-origin')).toBe('*');
  });
});
