import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { upsertValues } from '../src/ingest';
import worker from '../src/index';

// Fixed dispatch-interval base, aligned to an hour boundary (divisible by 300,
// 1800 and 3600) so bucket expectations are exact. scrape_time values are
// period-ENDING (AEMO SETTLEMENTDATE convention), and so are bucket labels.
const T0 = 1784901600;

async function get(path: string): Promise<Response> {
  return worker.fetch(new Request(`https://nem-api.test${path}`), env);
}

async function gidOf(duid: string): Promise<number> {
  const row = await env.DB.prepare('SELECT MIN(id) AS id FROM generators WHERE duid = ?')
    .bind(duid)
    .first<{ id: number }>();
  if (!row) throw new Error(`no generator seeded for DUID ${duid}`);
  return row.id;
}

// Seeded fixtures: BAPS = VIC1 Hydro/Water, BW01 + ER01 = NSW1 Fossil/Black Coal.
let baps: number;
let bw01: number;
let er01: number;

beforeEach(async () => {
  // vitest-pool-workers 0.18 (cloudflareTest plugin) has no per-test storage
  // isolation — tests in a file share one D1, so clear values explicitly.
  await env.DB.prepare('DELETE FROM scada_values').run();
  baps = await gidOf('BAPS');
  bw01 = await gidOf('BW01');
  er01 = await gidOf('ER01');
});

interface ValuesBody {
  start: number | null;
  end: number | null;
  resolution: number;
  truncated: boolean;
  timestamps: number[];
  series: Array<{ id: number; duid: string | null; name: string | null; fuel: string | null; values: (number | null)[] }>;
}

interface AggregateBody extends Omit<ValuesBody, 'series'> {
  group_by: string;
  series: Array<{ key: string; values: (number | null)[] }>;
}

describe('/api/v2/values', () => {
  it('returns the columnar contract: shared timestamps, aligned series with null gaps, no sql/vars', async () => {
    await upsertValues(env.DB, [
      { scrapeTime: T0, generatorId: baps, value: 10 },
      { scrapeTime: T0 + 300, generatorId: baps, value: 12 },
      { scrapeTime: T0 + 600, generatorId: baps, value: 14 },
      { scrapeTime: T0, generatorId: bw01, value: 600 },
      // bw01 has no sample at T0+300 -> null in its aligned array
      { scrapeTime: T0 + 600, generatorId: bw01, value: 620 },
    ]);

    const res = await get(`/api/v2/values?time_start=${T0}&time_end=${T0 + 600}&resolution=300`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');

    const body = await res.json<ValuesBody>();
    expect(body).not.toHaveProperty('sql');
    expect(body).not.toHaveProperty('vars');
    // restify-era envelope residue is gone from the public contract.
    expect(body).not.toHaveProperty('time');
    expect(body).not.toHaveProperty('duration');
    expect(body).not.toHaveProperty('num_results');
    expect(body.start).toBe(T0);
    expect(body.end).toBe(T0 + 600);
    expect(body.resolution).toBe(300);
    expect(body.truncated).toBe(false);
    expect(body.timestamps).toEqual([T0, T0 + 300, T0 + 600]);

    const bapsSeries = body.series.find((s) => s.id === baps);
    const bw01Series = body.series.find((s) => s.id === bw01);
    expect(bapsSeries).toMatchObject({ duid: 'BAPS', name: 'Banimboola Power Station', fuel: 'Hydro' });
    expect(bapsSeries?.values).toEqual([10, 12, 14]);
    expect(bw01Series?.values).toEqual([600, null, 620]);
  });

  it('buckets server-side at a coarse resolution (hourly mean, period-ending label)', async () => {
    // 12 five-minute samples with period-ending times inside the hour ending
    // T0+3600: mean(1..12) = 6.5, labelled by the bucket END.
    await upsertValues(
      env.DB,
      Array.from({ length: 12 }, (_, i) => ({ scrapeTime: T0 + (i + 1) * 300, generatorId: baps, value: i + 1 })),
    );

    const res = await get(`/api/v2/values?time_start=${T0}&time_end=${T0 + 3600}&resolution=3600`);
    const body = await res.json<ValuesBody>();
    expect(body.timestamps).toEqual([T0 + 3600]);
    expect(body.series).toHaveLength(1);
    expect(body.series[0].values).toEqual([6.5]);
  });

  it('labels buckets period-ENDING: a boundary sample belongs to the bucket ending there', async () => {
    await upsertValues(env.DB, [
      { scrapeTime: T0, generatorId: baps, value: 1 }, // ends exactly at T0 -> bucket T0
      { scrapeTime: T0 + 300, generatorId: baps, value: 2 }, // ends inside next period -> bucket T0+1800
    ]);

    const body = await (
      await get(`/api/v2/values?time_start=${T0}&time_end=${T0 + 300}&resolution=1800`)
    ).json<ValuesBody>();
    expect(body.timestamps).toEqual([T0, T0 + 1800]);
    expect(body.series[0].values).toEqual([1, 2]);
  });

  it('aligns daily buckets to NEM time (AEST midnight, not UTC)', async () => {
    // 2026-07-25 00:00 AEST == 2026-07-24 14:00 UTC.
    const dayEnd = Date.UTC(2026, 6, 24, 14, 0, 0) / 1000;
    await upsertValues(env.DB, [
      { scrapeTime: dayEnd - 3600, generatorId: baps, value: 5 }, // 23:00 AEST -> day ending dayEnd
      { scrapeTime: dayEnd + 300, generatorId: baps, value: 7 }, // 00:05 AEST -> next day
    ]);

    const body = await (
      await get(`/api/v2/values?time_start=${dayEnd - 3600}&time_end=${dayEnd + 300}&resolution=86400`)
    ).json<ValuesBody>();
    expect(body.timestamps).toEqual([dayEnd, dayEnd + 86400]);
    expect(body.series[0].values).toEqual([5, 7]);
  });

  it('applies relative windows off a given start (hours semantics)', async () => {
    await upsertValues(env.DB, [
      { scrapeTime: T0, generatorId: baps, value: 1 },
      { scrapeTime: T0 + 3600, generatorId: baps, value: 2 },
      { scrapeTime: T0 + 7200, generatorId: baps, value: 3 }, // outside [T0, T0+1h]
    ]);

    const res = await get(`/api/v2/values?time_start=${T0}&hours=1&resolution=300`);
    const body = await res.json<ValuesBody>();
    expect(body.start).toBe(T0);
    expect(body.end).toBe(T0 + 3600);
    expect(body.timestamps).toEqual([T0, T0 + 3600]);
    expect(body.series[0].values).toEqual([1, 2]);
  });

  it('defaults to the last 24 hours when no time params are given', async () => {
    const now = Math.floor(Date.now() / 1000);
    const recent = now - 3600 - (now % 300);
    const stale = now - 3 * 86400 - (now % 300);
    await upsertValues(env.DB, [
      { scrapeTime: recent, generatorId: baps, value: 42 },
      { scrapeTime: stale, generatorId: baps, value: 99 },
    ]);

    const body = await (await get('/api/v2/values')).json<ValuesBody>();
    expect(body.timestamps).toHaveLength(1);
    expect(body.series[0].values).toEqual([42]);
  });

  it('filters generators (fuel=... narrows the series set)', async () => {
    await upsertValues(env.DB, [
      { scrapeTime: T0, generatorId: baps, value: 10 },
      { scrapeTime: T0, generatorId: bw01, value: 600 },
    ]);

    const res = await get(`/api/v2/values?time_start=${T0}&time_end=${T0}&fuel=Hydro&resolution=300`);
    const body = await res.json<ValuesBody>();
    expect(body.series.map((s) => s.id)).toEqual([baps]);
  });

  it('clamps limit as a plain integer, reports truncation, and honours offset', async () => {
    await upsertValues(
      env.DB,
      Array.from({ length: 300 }, (_, i) => ({ scrapeTime: T0 + i * 300, generatorId: baps, value: i })),
    );
    const range = `time_start=${T0}&time_end=${T0 + 299 * 300}&resolution=300`;

    const first = await (await get(`/api/v2/values?${range}&limit=100`)).json<ValuesBody>();
    expect(first.timestamps).toHaveLength(100);
    expect(first.timestamps[0]).toBe(T0);
    expect(first.truncated).toBe(true);

    const rest = await (await get(`/api/v2/values?${range}&limit=100&offset=100`)).json<ValuesBody>();
    expect(rest.timestamps[0]).toBe(T0 + 100 * 300);

    const all = await (await get(`/api/v2/values?${range}`)).json<ValuesBody>();
    expect(all.timestamps).toHaveLength(300);
    expect(all.truncated).toBe(false);
  });

  it('rejects malformed limit/offset explicitly', async () => {
    expect((await get('/api/v2/values?limit=0')).status).toBe(400);
    expect((await get('/api/v2/values?limit=lots')).status).toBe(400);
    expect((await get('/api/v2/values?offset=-1')).status).toBe(400);
  });

  it('supports sort=time,desc', async () => {
    await upsertValues(env.DB, [
      { scrapeTime: T0, generatorId: baps, value: 1 },
      { scrapeTime: T0 + 300, generatorId: baps, value: 2 },
    ]);

    // Descending row order changes which rows a LIMIT window covers; the
    // pivoted timestamps axis stays ascending by contract.
    const body = await (
      await get(`/api/v2/values?time_start=${T0}&time_end=${T0 + 300}&resolution=300&sort=time,desc`)
    ).json<ValuesBody>();
    expect(body.timestamps).toEqual([T0, T0 + 300]);
  });

  it('rejects unknown sort columns instead of interpolating them (incl. the dropped scrape_time alias)', async () => {
    const res = await get('/api/v2/values?sort=value;DROP TABLE generators;--');
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toContain('invalid sort');

    // Storage-column vocabulary is no longer public sort surface.
    expect((await get('/api/v2/values?sort=scrape_time')).status).toBe(400);
  });

  it('binds filter values: an injection attempt matches nothing and damages nothing', async () => {
    await upsertValues(env.DB, [{ scrapeTime: T0, generatorId: baps, value: 10 }]);

    const res = await get(
      `/api/v2/values?time_start=${T0}&time_end=${T0}&state=${encodeURIComponent("VIC1' OR '1'='1")}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json<ValuesBody>();
    expect(body.series).toEqual([]);
    expect(body.timestamps).toEqual([]);

    const still = await env.DB.prepare('SELECT count(*) AS n FROM generators').first<{ n: number }>();
    expect(still?.n).toBe(350);
  });

  it('rejects malformed time params explicitly', async () => {
    const res = await get('/api/v2/values?time_start=not-a-date');
    expect(res.status).toBe(400);
  });

  it('accepts ISO date strings for the window bounds', async () => {
    await upsertValues(env.DB, [{ scrapeTime: T0, generatorId: baps, value: 10 }]);
    const startIso = new Date(T0 * 1000).toISOString();
    const endIso = new Date((T0 + 300) * 1000).toISOString();

    const body = await (
      await get(`/api/v2/values?time_start=${encodeURIComponent(startIso)}&time_end=${encodeURIComponent(endIso)}`)
    ).json<ValuesBody>();
    expect(body.start).toBe(T0);
    expect(body.end).toBe(T0 + 300);
    expect(body.timestamps).toEqual([T0]);
  });

  it('interprets offset-less ISO strings as NEM time (AEST), never the runtime timezone', async () => {
    // 2026-07-24T00:00:00 AEST == 2026-07-23T14:00:00Z.
    const aestMidnight = Date.UTC(2026, 6, 23, 14, 0, 0) / 1000;

    const naive = await (
      await get(`/api/v2/values?time_start=${encodeURIComponent('2026-07-24T00:00:00')}&hours=1`)
    ).json<ValuesBody>();
    expect(naive.start).toBe(aestMidnight);

    // Date-only means AEST midnight; an explicit offset is honoured as given.
    const dateOnly = await (await get('/api/v2/values?time_start=2026-07-24&hours=1')).json<ValuesBody>();
    expect(dateOnly.start).toBe(aestMidnight);

    const explicit = await (
      await get(`/api/v2/values?time_start=${encodeURIComponent('2026-07-23T14:00:00Z')}&hours=1`)
    ).json<ValuesBody>();
    expect(explicit.start).toBe(aestMidnight);
  });
});

describe('/api/v2/values/aggregate', () => {
  it('groups totals by fuel over time buckets (mean of per-interval sums, period-ending label)', async () => {
    await upsertValues(env.DB, [
      // Interval ending T0+300: Hydro 10, Fossil 600 + 700.
      { scrapeTime: T0 + 300, generatorId: baps, value: 10 },
      { scrapeTime: T0 + 300, generatorId: bw01, value: 600 },
      { scrapeTime: T0 + 300, generatorId: er01, value: 700 },
      // Interval ending T0+600 (same 30-min bucket ending T0+1800): Hydro 20, Fossil 620 + 680.
      { scrapeTime: T0 + 600, generatorId: baps, value: 20 },
      { scrapeTime: T0 + 600, generatorId: bw01, value: 620 },
      { scrapeTime: T0 + 600, generatorId: er01, value: 680 },
    ]);

    const res = await get(
      `/api/v2/values/aggregate?group_by=fuel&time_start=${T0}&time_end=${T0 + 600}&resolution=1800`,
    );
    expect(res.status).toBe(200);
    const body = await res.json<AggregateBody>();
    expect(body.group_by).toBe('fuel');
    expect(body.timestamps).toEqual([T0 + 1800]);
    // Fossil: mean(1300, 1300) = 1300; Hydro: mean(10, 20) = 15.
    expect(body.series).toEqual([
      { key: 'Fossil', values: [1300] },
      { key: 'Hydro', values: [15] },
    ]);
  });

  it('groups by region (first-class NEM dimension) and composes with generator filters', async () => {
    await upsertValues(env.DB, [
      { scrapeTime: T0, generatorId: baps, value: 10 }, // VIC1 Hydro
      { scrapeTime: T0, generatorId: bw01, value: 600 }, // NSW1 Fossil
    ]);

    const body = await (
      await get(`/api/v2/values/aggregate?group_by=region&time_start=${T0}&time_end=${T0}&fuel=Fossil`)
    ).json<AggregateBody>();
    expect(body.group_by).toBe('region');
    expect(body.series).toEqual([{ key: 'NSW1', values: [600] }]);
  });

  it('nets negative values through the sum (storage charging / station load convention)', async () => {
    await upsertValues(env.DB, [
      { scrapeTime: T0, generatorId: baps, value: 10 }, // Hydro generating
      { scrapeTime: T0, generatorId: bw01, value: -5 }, // Fossil unit drawing (station load)
    ]);

    const body = await (
      await get(`/api/v2/values/aggregate?group_by=fuel&time_start=${T0}&time_end=${T0}`)
    ).json<AggregateBody>();
    expect(body.series).toEqual([
      { key: 'Fossil', values: [-5] },
      { key: 'Hydro', values: [10] },
    ]);
  });

  it('rejects a missing or unknown group_by', async () => {
    expect((await get('/api/v2/values/aggregate')).status).toBe(400);
    expect((await get('/api/v2/values/aggregate?group_by=duid')).status).toBe(400);
  });
});

describe('/api/v2/generators', () => {
  interface GeneratorRow {
    id: number;
    duid: string;
    name: string;
    state: string;
    fuel_type: string | null;
    fuel_description: string | null;
  }

  it('infers = for a plain value; region is canonical with state as alias', async () => {
    const byRegion = await (await get('/api/v2/generators?region=VIC1')).json<GeneratorRow[]>();
    expect(byRegion.length).toBeGreaterThan(0);
    expect(byRegion.every((r) => r.state === 'VIC1')).toBe(true);

    const byState = await (await get('/api/v2/generators?state=VIC1')).json<GeneratorRow[]>();
    expect(byState).toEqual(byRegion);
  });

  it('infers IN for comma-separated values', async () => {
    const rows = await (await get('/api/v2/generators?region=VIC1,NSW1')).json<GeneratorRow[]>();
    const states = new Set(rows.map((r) => r.state));
    expect(states).toEqual(new Set(['VIC1', 'NSW1']));
  });

  it('infers LIKE only for * (the sole public wildcard); % is a literal', async () => {
    const rows = await (await get('/api/v2/generators?fuel_desc=Wat*')).json<GeneratorRow[]>();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.fuel_description?.startsWith('Wat'))).toBe(true);

    // % no longer opens a LIKE — it is compared literally and matches nothing here.
    const literal = await (await get('/api/v2/generators?fuel_desc=Wat%25')).json<GeneratorRow[]>();
    expect(literal).toEqual([]);
  });

  it('supports duid selection and canonical-over-alias resolution', async () => {
    const rows = await (await get('/api/v2/generators?duid=BAPS,BW01')).json<GeneratorRow[]>();
    expect(new Set(rows.map((r) => r.duid))).toEqual(new Set(['BAPS', 'BW01']));

    // Canonical `fuel` wins when its column alias `fuel_type` is also present.
    const fuelWins = await (await get('/api/v2/generators?fuel=Hydro&fuel_type=Fossil')).json<GeneratorRow[]>();
    expect(fuelWins.length).toBeGreaterThan(0);
    expect(fuelWins.every((r) => r.fuel_type === 'Hydro')).toBe(true);
  });

  it('binds injection attempts harmlessly', async () => {
    const rows = await (
      await get(`/api/v2/generators?region=${encodeURIComponent("x'; DROP TABLE generators;--")}`)
    ).json<GeneratorRow[]>();
    expect(rows).toEqual([]);
    const still = await env.DB.prepare('SELECT count(*) AS n FROM generators').first<{ n: number }>();
    expect(still?.n).toBe(350);
  });
});

describe('routing', () => {
  it('answers CORS preflight', async () => {
    const res = await worker.fetch(new Request('https://nem-api.test/api/v2/values', { method: 'OPTIONS' }), env);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('404s unknown API routes with JSON, 405s non-GET', async () => {
    const notFound = await get('/api/v2/nope');
    expect(notFound.status).toBe(404);
    expect((await notFound.json<{ error: string }>()).error).toContain('/api/v2/values');

    const post = await worker.fetch(new Request('https://nem-api.test/api/v2/values', { method: 'POST' }), env);
    expect(post.status).toBe(405);
  });
});
