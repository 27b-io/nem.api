import { ByteStorage, createCache, MessagePackSerializer, workersCacheAPI } from '@cachekit-io/cachekit/workers';
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boundaryTtl,
  buildCacheEntry,
  cacheInstance,
  CLOSED_WINDOW_TTL_SECONDS,
  GENERATORS_TTL_SECONDS,
  INGEST_GRACE_SECONDS,
  L1_LIMITS,
  ROOFTOP_PUBLICATION_GRACE_SECONDS,
  SERIALIZER_LIMITS,
} from '../src/cache';
import { upsertValues } from '../src/ingest';
import worker from '../src/index';

// Same hour-aligned dispatch base as api.spec.ts — safely in the past, so
// absolute windows against it are "closed" and cache long.
const T0 = 1784901600;
// A boundary-aligned "now" for deterministic policy tests.
const NOW = T0 + 7 * 86400;


/**
 * A /api/v2/values body at production scale and production SHAPE: the columnar
 * payload handleValues returns (one shared `timestamps` axis, one aligned
 * `values` array per generator, nulls for gaps), always 600 DUIDs — so
 * `buckets` alone sets how close the body sits to the 300000-row MAX_LIMIT
 * ceiling the handler clips at.
 *
 * Values come from an LCG so the compression numbers are not flattered by an
 * artificial period, and Math.imul is load-bearing for that: plain
 * `seed * 1103515245` overflows 2^53, destroys the low bits, collapses the
 * period to ~10k and repeats whole series verbatim, which inflated the
 * measured ratio by ~10% until the expert panel caught it.
 *
 * Shape on top of that is dispatch-like: ~25% of units sit at exactly 0 (real
 * NEM — most registered DUIDs are offline at any moment), the rest hold their
 * setpoint across several intervals before moving, which is how dispatch
 * actually behaves. Still a model, so treat the measured ratio as indicative
 * of the shape, not as a promise about a specific query.
 */
function productionBody(buckets: number): string {
  const timestamps = Array.from({ length: buckets }, (_, i) => T0 + i * 300);
  let seed = 0x2545f491;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
  const series = Array.from({ length: 600 }, (_, s) => {
    const offline = rand() < 0.25;
    const values: (number | null)[] = [];
    let held = Math.round(rand() * 42000); // centi-MW, so values carry 2 decimals
    for (let i = 0; i < buckets; i++) {
      if (rand() < 0.02) values.push(null); // ingest gap
      else if (offline) values.push(0);
      else {
        if (rand() < 0.3) held = Math.max(0, held + Math.round((rand() - 0.5) * 6000));
        values.push(held / 100);
      }
    }
    return {
      id: s + 1,
      duid: `${['BW', 'ER', 'LD', 'MP', 'YW'][s % 5]}${String(s).padStart(3, '0')}1`,
      name: `Generator ${s} Power Station Unit ${(s % 4) + 1}`,
      fuel: ['Wind', 'Solar', 'Black Coal', 'Natural Gas', 'Water'][s % 5],
      values,
    };
  });
  return JSON.stringify({
    start: T0,
    end: timestamps[buckets - 1],
    resolution: 300,
    truncated: false,
    timestamps,
    series,
  });
}

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

  it('dispatch keys: alias collapse, region canonicalisation, and ignored params (LAB-1700)', () => {
    const dis = (q: string, now = NOW) => entryFor(q, now, 'nem-api.test', '/api/v2/dispatch')!;
    expect(dis('?region=VIC1').key).toBe(dis('?state=VIC1').key);
    expect(dis('?region=SA1,NSW1').key).toBe(dis('?region=NSW1,SA1').key);
    // dispatch has no sort and no generator filters — params its handler
    // ignores must not fragment the cache.
    expect(dis('?region=VIC1&sort=value,desc&fuel=Hydro').key).toBe(dis('?region=VIC1').key);
    // distinct from the sibling routes' keys, and from other regions.
    expect(dis('?region=VIC1').key).not.toBe(dis('?region=NSW1').key);
    expect(dis(`?time_start=${T0}`).key).not.toBe(entryFor(`?time_start=${T0}`)!.key);
    // TTL policy matches values: closed absolute windows cache long, relative
    // windows to the dispatch boundary.
    expect(dis(`?time_start=${T0}&time_end=${T0 + 600}`).ttl).toBe(CLOSED_WINDOW_TTL_SECONDS);
    expect(dis('?hours=24', NOW + 100).ttl).toBe(200);
  });

  it('rooftop keys: alias collapse, ignored params, and the publication-lag close (LAB-1701)', () => {
    const roof = (q: string, now = NOW) => entryFor(q, now, 'nem-api.test', '/api/v2/rooftop')!;
    expect(roof('?region=VIC1').key).toBe(roof('?state=VIC1').key);
    expect(roof('?region=VIC1&sort=value,desc&fuel=Hydro').key).toBe(roof('?region=VIC1').key);
    expect(roof(`?time_start=${T0}`).key).not.toBe(entryFor(`?time_start=${T0}`)!.key);
    // Safely-past absolute windows cache long, relative windows to the boundary.
    expect(roof(`?time_start=${T0}&time_end=${T0 + 3600}`).ttl).toBe(CLOSED_WINDOW_TTL_SECONDS);
    expect(roof('?hours=24', NOW + 100).ttl).toBe(200);
    // The estimate for the half-hour ending T is only PUBLISHED ~T+30min: a
    // window ending on a just-finished half-hour must NOT close on the 5-min
    // dispatch clock (dispatch closes this same window long already).
    const justEnded = `?time_start=${NOW - 7200}&time_end=${NOW}`;
    expect(entryFor(justEnded, NOW + 300, 'nem-api.test', '/api/v2/dispatch')!.ttl).toBe(CLOSED_WINDOW_TTL_SECONDS);
    expect(roof(justEnded, NOW + 300).ttl).toBe(boundaryTtl(NOW + 300));
    // Once the publication grace has passed, it closes like the others.
    expect(roof(justEnded, NOW + ROOFTOP_PUBLICATION_GRACE_SECONDS).ttl).toBe(CLOSED_WINDOW_TTL_SECONDS);
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

  it('rollup-served aggregates stay boundary-cached until their edge bucket completes (LAB-1696)', () => {
    // time_end is past, but the daily bucket containing it (ends T0+86400)
    // is still filling — the rollup path serves the FULL bucket, so the
    // response keeps changing and must not cache as closed.
    const agg = (q: string, now: number) => entryFor(q, now, 'nem-api.test', '/api/v2/values/aggregate')!;
    const q = `?group_by=fuel&time_start=${T0}&time_end=${T0 + 600}&resolution=86400`;
    const midBucket = T0 + 43200;
    expect(agg(q, midBucket).ttl).toBe(boundaryTtl(midBucket));
    // The fine-resolution /values twin of the same window IS closed at that
    // moment — 300/1800 stay on the raw path and clip to the window.
    expect(entryFor(q.replace('group_by=fuel&', '').replace('resolution=86400', 'resolution=1800'), midBucket)!.ttl).toBe(
      CLOSED_WINDOW_TTL_SECONDS,
    );
    // Once the bucket end clears the ingest grace, the aggregate closes too.
    expect(agg(q, T0 + 86400 + INGEST_GRACE_SECONDS).ttl).toBe(CLOSED_WINDOW_TTL_SECONDS);
    // Exact-time aggregate lookups stay on the raw path and close as before.
    expect(agg(`?group_by=fuel&time=${T0 + 600}&resolution=86400`, midBucket).ttl).toBe(CLOSED_WINDOW_TTL_SECONDS);
  });

  it('rollup-served /values gets the same edge-bucket treatment (LAB-1721)', () => {
    // Same seam as the aggregate above, now that `values` at 3600/86400 also
    // reads the rollup tables and reports the FULL straddling bucket.
    const q = `?time_start=${T0}&time_end=${T0 + 600}&resolution=86400`;
    const midBucket = T0 + 43200;
    expect(entryFor(q, midBucket)!.ttl).toBe(boundaryTtl(midBucket));
    expect(entryFor(q, T0 + 86400 + INGEST_GRACE_SECONDS)!.ttl).toBe(CLOSED_WINDOW_TTL_SECONDS);
    // Exact-time lookups stay on the raw path and close as before.
    expect(entryFor(`?time=${T0 + 600}&resolution=86400`, midBucket)!.ttl).toBe(CLOSED_WINDOW_TTL_SECONDS);
  });

  it('rollup-served intensity gets the same edge-bucket treatment (LAB-1698)', () => {
    // Same seam as the aggregate above: /api/v2/intensity is rollup-served at
    // 3600/86400 and returns the FULL straddling bucket, so pinning it as
    // closed would publish a partial day's carbon intensity as final for 24 h.
    const ci = (q: string, now: number) => entryFor(q, now, 'nem-api.test', '/api/v2/intensity')!;
    const q = `?time_start=${T0}&time_end=${T0 + 600}&resolution=86400`;
    const midBucket = T0 + 43200;
    expect(ci(q, midBucket).ttl).toBe(boundaryTtl(midBucket));
    expect(ci(q, T0 + 86400 + INGEST_GRACE_SECONDS).ttl).toBe(CLOSED_WINDOW_TTL_SECONDS);
  });

  it('ignores params intensity does not read, so they cannot mint duplicate entries', () => {
    // limit/offset/sort/generator filters are unrecognised on this route — a
    // recognised-elsewhere param must not become a free cache-bust here.
    const ci = (q: string) => entryFor(q, NOW, 'nem-api.test', '/api/v2/intensity')!.key;
    const base = ci(`?time_start=${T0}&time_end=${T0 + 600}`);
    expect(ci(`?time_start=${T0}&time_end=${T0 + 600}&limit=5&offset=99`)).toBe(base);
    expect(ci(`?time_start=${T0}&time_end=${T0 + 600}&region=NSW1&sort=value,desc`)).toBe(base);
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

  it('round-trips a ceiling-sized production-shaped body through the configured instance', async () => {
    // Two things at once: cachekit's 1 MiB encode default would throw
    // ValueTooLargeError here (heaviest queries silently never cached), and
    // the LAB-1765 ByteStorage envelope has to survive a real wasm
    // pack/unpack under vitest-pool-workers. A length check would pass on a
    // corrupted payload, so compare the whole body — but as a boolean, since
    // toEqual on a mismatch would try to diff two multi-MB strings and wedge
    // the run that was supposed to tell us what broke.
    const key = `test:big:${host}`;
    const body = productionBody(500); // 300000 rows, the MAX_LIMIT ceiling
    expect(body.length).toBeGreaterThan(1024 * 1024);
    await cacheInstance().set(key, { body, expires: 1 }, { ttl: 60 });
    const hit = await cacheInstance().get<{ body: string; expires: number }>(key);
    expect(hit?.body === body).toBe(true);
    expect(hit?.expires).toBe(1);
  });
});

/**
 * LAB-1765: compression is ON, which changes the STORED BYTES. These pin the
 * two things that decision rests on — that the envelope actually pays for
 * itself on this workload, and that a config/entry mismatch in either
 * direction can never serve a wrong body.
 */
describe('compression — ByteStorage envelope', () => {
  let host: string;

  /** A cache configured exactly like production except compression OFF. */
  function plainCache() {
    return createCache.minimal({
      backend: workersCacheAPI(),
      compression: false,
      l1: { enabled: false },
      serializer: SERIALIZER_LIMITS,
    });
  }

  beforeEach(() => {
    host = `t-${crypto.randomUUID()}.test`;
  });

  it('shrinks a production-shaped body, and the measurement is the decision record', async () => {
    // Two shapes: 288 buckets is the DEFAULT query (no params = 24 h, 172800
    // rows, what the dashboard actually asks for), 500 is 300000 rows exactly
    // — the MAX_LIMIT ceiling, so the widest body the handler can emit.
    //
    // Sizes only. Latency was measured on the flip with the same bodies and
    // recorded in src/cache.ts and on LAB-1765, then the timing harness was
    // dropped: miniflare has no production baseline to regress against, so it
    // would have been 20 multi-MB round trips per CI run asserting nothing.
    // Re-measure by deploying, not by trusting a number from this file.
    for (const buckets of [288, 500]) {
      const value = { body: productionBody(buckets), expires: T0 + 300 };
      // The exact pipeline cache-core runs — serializer.encode() then
      // byteStorage.pack() — so these ARE the bytes each config hands the Cache
      // API, not a proxy for them. This measures the CODEC, not the shipped
      // config: what pins `compression: true` in src/cache.ts is the pair of
      // mismatch tests below, which go red on a revert.
      const plain = new MessagePackSerializer(SERIALIZER_LIMITS).encode(value);
      const packed = new ByteStorage().pack(plain);
      const ratio = plain.length / packed.length;
      console.log(
        `[LAB-1765] ${buckets} buckets x 600 series: ${(value.body.length / 1024).toFixed(0)} KiB JSON, ` +
          `stored ${(plain.length / 1024).toFixed(0)} -> ${(packed.length / 1024).toFixed(0)} KiB (${ratio.toFixed(2)}x)`,
      );
      // Asserted per shape, not after the loop: hoisting it would leave the
      // 288 case — the common one — with no assertion at all. The floor sits
      // just under the measured 2.5x/2.7x, so a codec that stopped working
      // fails instead of passing on a technicality.
      expect(ratio).toBeGreaterThan(2.2);
    }
  });

  it('survives a pre-flip plain entry — the error storm the KEY_VERSION bump avoids', async () => {
    // What a plain (pre-k5) entry does to the k5 reader, end to end. unpack cannot read
    // bare MessagePack and createCache.minimal disables degradation, so the
    // get THROWS rather than returning null — handleApiCached's own catch is
    // what keeps the endpoint up, and the refill overwrites the entry. The
    // `expires` here is far future, so a stale body could only appear if the
    // entry were actually readable.
    const url = new URL(`https://${host}/api/v2/generators?duid=BAPS`);
    const key = buildCacheEntry(url, Math.floor(Date.now() / 1000))!.key;
    await plainCache().set(key, { body: '{"stale":true}', expires: 2 ** 31 }, { ttl: 60 });

    await expect(cacheInstance().get(key)).rejects.toThrow();

    const res = await worker.fetch(new Request(url.toString()), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('MISS');
    expect(await res.text()).not.toContain('stale');
  });

  it('never serves a decodable-but-foreign entry as a body', async () => {
    // The other direction, and the reason a revert is not a one-line config
    // change: the ByteStorage envelope is itself valid positional MessagePack,
    // so a compression-off reader decodes an enveloped entry SUCCESSFULLY and
    // returns the 4-tuple [compressed, checksum, size, 'msgpack'] as the
    // value. No throw, nothing for degradation to catch, and `hit.body`
    // undefined used to become an empty 200 stamped `x-cache: HIT` and cached
    // client-side for the full TTL.
    //
    // Asserted against isCachedResponse rather than against the cachekit bug:
    // any decodable non-CachedResponse must become a MISS, whatever produced
    // it (a missed KEY_VERSION bump, a revert, a future shape change). Pinning
    // the vendor misread instead would have gone red on the upstream fix
    // (LAB-1388, shipped in 0.2.0) without the guard ever regressing.
    const url = new URL(`https://${host}/api/v2/generators?duid=BAPS`);
    const key = buildCacheEntry(url, Math.floor(Date.now() / 1000))!.key;
    await cacheInstance().set(key, ['not', 'a', 'CachedResponse'], { ttl: 60 });

    const res = await worker.fetch(new Request(url.toString()), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache')).toBe('MISS');
    // A real refilled body, not the empty 200 the missing guard used to serve.
    const generators: Array<{ duid: string }> = JSON.parse(await res.text());
    expect(generators.length).toBeGreaterThan(0);
    expect(generators[0].duid).toBe('BAPS');
  });
});

/**
 * LAB-1766: L1 is on. Each test isolates L1 the same way: write or read
 * through the configured instance, then delete the Cache API copy through a
 * second, L1-less instance — from then on only the configured instance's L1
 * can answer. Date is faked so lifetimes are asserted to the second without
 * sleeping; L1 and cachekit's receipt clock both read Date.now().
 */
describe('L1 — in-isolate tier', () => {
  let host: string;

  /** Same backend and wire format as production, no L1: a Cache-API-only view. */
  function l2Only() {
    return createCache.minimal({
      backend: workersCacheAPI(),
      compression: true,
      l1: { enabled: false },
      serializer: SERIALIZER_LIMITS,
    });
  }

  beforeEach(() => {
    host = `t-${crypto.randomUUID()}.test`;
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('an L2 hit repopulates L1 only until the ORIGINAL expiry, not defaultTtl (LAB-1388)', async () => {
    // The exact failure mode: a plain get() (no ttl) that misses L1 and hits
    // L2. cachekit 0.1.5 refilled L1 for the preset's defaultTtl (300 s), so
    // this 30 s entry would still be served at t=31 s — the last assertion is
    // red under 0.1.5 semantics.
    const key = `test:l1-repop:${host}`;
    const writer = l2Only();
    await writer.set(key, { body: 'b', expires: 0 }, { ttl: 30 });
    expect(await cacheInstance().get(key)).not.toBeNull(); // L2 hit, repopulates L1

    await writer.delete(key);
    expect(await cacheInstance().get(key)).not.toBeNull(); // L1 alone answers

    vi.setSystemTime(Date.now() + 29_000);
    expect(await cacheInstance().get(key)).not.toBeNull(); // the cap is not too short either

    vi.setSystemTime(Date.now() + 2_000);
    expect(await cacheInstance().get(key)).toBeNull(); // gone at the original boundary
  });

  it('an L1-served hit reports the REMAINING lifetime in cache-control and x-cache-expires', async () => {
    const url = new URL(`https://${host}/api/v2/generators?duid=BAPS`);
    const miss = await worker.fetch(new Request(url.toString()), env);
    expect(miss.headers.get('x-cache')).toBe('MISS');
    expect(miss.headers.get('cache-control')).toBe(`public, max-age=${GENERATORS_TTL_SECONDS}`);
    const expires = Number(miss.headers.get('x-cache-expires'));

    await l2Only().delete(buildCacheEntry(url, Math.floor(Date.now() / 1000))!.key);
    vi.setSystemTime(Date.now() + 100_000);

    const hit = await worker.fetch(new Request(url.toString()), env);
    expect(hit.headers.get('x-cache')).toBe('HIT');
    expect(hit.headers.get('x-cache-expires')).toBe(String(expires));
    expect(hit.headers.get('cache-control')).toBe(`public, max-age=${expires - Math.floor(Date.now() / 1000)}`);
    expect(await hit.json()).toEqual(await miss.json());
  });

  it('a copy a tier still holds past its own `expires` is a miss, not a hit', async () => {
    // The tiers only approximate the boundary: Cache API max-age counts from
    // the write (after the D1 query), and L1's cap is whole-second and trusts
    // the edge's Age. Here L1 holds the entry for 60 s but its boundary is 10 s
    // out, so at t=11 s only handleApiCached's own check stands between the
    // request and a past-boundary body.
    const url = new URL(`https://${host}/api/v2/generators?duid=BAPS`);
    const key = buildCacheEntry(url, Math.floor(Date.now() / 1000))!.key;
    const expires = Math.floor(Date.now() / 1000) + 10;
    await cacheInstance().set(key, { body: '{"stale":true}', expires }, { ttl: 60 });

    const before = await worker.fetch(new Request(url.toString()), env);
    expect(before.headers.get('x-cache')).toBe('HIT');

    vi.setSystemTime(Date.now() + 11_000);
    const after = await worker.fetch(new Request(url.toString()), env);
    expect(after.headers.get('x-cache')).toBe('MISS');
    expect(await after.text()).not.toContain('stale');
  });

  it('holds dashboard-sized bodies and refuses multi-MB ones (L1_LIMITS)', async () => {
    // cachekit refuses an entry charged above maxMemory / 8, and charges about
    // 1.75x the serialized size. The bound is the decision, so pin both sides:
    // a ~20 KiB dashboard body is admitted, a 1.6 MB ceiling body is not.
    // Raising L1_LIMITS.maxMemory far enough turns this red, as it should.
    const small = `test:l1-small:${host}`;
    const big = `test:l1-big:${host}`;
    const bigBody = productionBody(500);
    expect(bigBody.length).toBeLessThan(L1_LIMITS.maxMemory / 8); // refused on the charge, not the raw size
    await cacheInstance().set(small, { body: 'x'.repeat(20 * 1024), expires: 1 }, { ttl: 60 });
    await cacheInstance().set(big, { body: bigBody, expires: 1 }, { ttl: 60 });

    const writer = l2Only();
    await writer.delete(small);
    await writer.delete(big);

    expect(await cacheInstance().get(small)).not.toBeNull();
    expect(await cacheInstance().get(big)).toBeNull();
  });
});
