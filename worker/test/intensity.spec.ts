import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildCacheEntry, CLOSED_WINDOW_TTL_SECONDS, INGEST_GRACE_SECONDS } from '../src/cache';
import { refreshTouchedRollups, upsertValues } from '../src/ingest';
import worker from '../src/index';

// T0 = 2026-07-25 00:00 AEST — an AEST midnight AND an hour boundary (same
// base as rollups.spec.ts). Buckets are period-ENDING.
const T0 = 1784901600;
const HOUR = 3600;
const DAY = 86400;

let host: string;

async function get(path: string): Promise<Response> {
  return worker.fetch(new Request(`https://${host}${path}`), env);
}

async function gidOf(duid: string): Promise<number> {
  const row = await env.DB.prepare('SELECT MIN(id) AS id FROM generators WHERE duid = ?')
    .bind(duid)
    .first<{ id: number | null }>();
  // MIN(id) always yields one row; a missing DUID surfaces as { id: null }.
  if (row?.id == null) throw new Error(`no generator seeded for DUID ${duid}`);
  return row.id;
}

// Seeded fixtures: BAPS = VIC1 Hydro, BW01 + ER01 = NSW1 Fossil. Test-local
// extras (id >= 9000): TSTX1 = NSW1 unit with NO published factor,
// TSTBAT1 = SA1 battery with factor 0.
let baps: number;
let bw01: number;
let er01: number;
const TSTX1 = 9001;
const TSTBAT1 = 9002;

interface Row {
  scrapeTime: number;
  generatorId: number;
  value: number;
}

/** Upsert raw rows and refresh rollups exactly the way both ingest paths do. */
async function seed(rows: Row[]): Promise<void> {
  await upsertValues(env.DB, rows);
  await refreshTouchedRollups(env.DB, rows);
}

interface IntensityBody {
  start: number | null;
  end: number | null;
  resolution: number;
  units: string;
  timestamps: number[];
  series: Array<{ key: string; coverage: number | null; values: (number | null)[] }>;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM scada_values'),
    env.DB.prepare('DELETE FROM scada_hourly'),
    env.DB.prepare('DELETE FROM scada_daily'),
    env.DB.prepare('DELETE FROM scada_intervals'),
    env.DB.prepare('DELETE FROM emission_factors'),
    env.DB.prepare('DELETE FROM generators WHERE id >= 9000'),
    env.DB.prepare(
      "INSERT INTO generators (id, name, participant_name, duid, state) VALUES " +
        `(${TSTX1}, 'Unfactored Unit', 'Test', 'TSTX1', 'NSW1'), ` +
        `(${TSTBAT1}, 'Test Battery', 'Test', 'TSTBAT1', 'SA1')`,
    ),
  ]);
  host = `t-${crypto.randomUUID()}.test`;
  baps = await gidOf('BAPS');
  bw01 = await gidOf('BW01');
  er01 = await gidOf('ER01');
  // Per-DUID factors; TSTX1 deliberately has none. Two genset rows for BW01
  // with the SAME factor mirror the live file's multi-genset DUIDs.
  await env.DB.prepare(
    'INSERT INTO emission_factors (duid, genset_id, station_name, region, factor, energy_source, data_source) VALUES ' +
      "('BW01', 'BW01A', 'Bayswater', 'NSW1', 0.9, 'Black coal', 'NGA 2024'), " +
      "('BW01', 'BW01B', 'Bayswater', 'NSW1', 0.9, 'Black coal', 'NGA 2024'), " +
      "('ER01', 'ER01', 'Eraring', 'NSW1', 0.8, 'Black coal', 'NGA 2024'), " +
      "('BAPS', 'BAPS', 'Banimboola', 'VIC1', 0.0, 'Water', 'ISP2024'), " +
      "('TSTBAT1', 'TSTBAT1', 'Test Battery', 'SA1', 0.0, 'Battery', 'ISP2024')",
  ).run();
});

describe('raw-path intensity math', () => {
  it('computes ratio-of-sums per region + NEM, excludes unfactored MW from the ratio, discloses coverage', async () => {
    await seed([
      // bucket T0+300: NSW1 = BW01 100@0.9 + ER01 50@0.8 + TSTX1 50 (no factor); VIC1 = BAPS 200@0
      { scrapeTime: T0 + 300, generatorId: bw01, value: 100 },
      { scrapeTime: T0 + 300, generatorId: er01, value: 50 },
      { scrapeTime: T0 + 300, generatorId: TSTX1, value: 50 },
      { scrapeTime: T0 + 300, generatorId: baps, value: 200 },
      // bucket T0+600: NSW1 = BW01 100@0.9; VIC1 = BAPS 100@0
      { scrapeTime: T0 + 600, generatorId: bw01, value: 100 },
      { scrapeTime: T0 + 600, generatorId: baps, value: 100 },
      // bucket T0+900: only the unfactored unit generates
      { scrapeTime: T0 + 900, generatorId: TSTX1, value: 50 },
    ]);

    const res = await get(`/api/v2/intensity?time_start=${T0}&time_end=${T0 + 900}&resolution=300`);
    expect(res.status).toBe(200);
    const body = await res.json<IntensityBody>();
    expect(body.units).toBe('tCO2e/MWh');
    expect(body.timestamps).toEqual([T0 + 300, T0 + 600, T0 + 900]);
    expect(body.series).toEqual([
      // NEM bucket1: em = 100*0.9 + 50*0.8 = 130, mw_f = 350 → 0.3714;
      // bucket2: 90/200 = 0.45; bucket3: no factored MW → null (never 0).
      // Coverage = latest generating bucket (T0+900): 0/50 = 0.
      { key: 'NEM', coverage: 0, values: [round4(130 / 350), 0.45, null] },
      // NSW1: 130/150 = 0.8667, 0.9, null; coverage at T0+900 = 0.
      { key: 'NSW1', coverage: 0, values: [round4(130 / 150), 0.9, null] },
      // VIC1 (hydro, factor 0): fully covered, zero-intensity — a real 0, not null.
      { key: 'VIC1', coverage: 1, values: [0, 0, null] },
    ]);
  });

  it('excludes charging/negative MW from numerator and denominator', async () => {
    await seed([
      { scrapeTime: T0 + 300, generatorId: bw01, value: 100 },
      { scrapeTime: T0 + 300, generatorId: TSTBAT1, value: -70 }, // charging: excluded entirely
    ]);
    const body = await (
      await get(`/api/v2/intensity?time_start=${T0}&time_end=${T0 + 300}&resolution=300`)
    ).json<IntensityBody>();
    // SA1 contributes no generation, so no SA1 series and NEM == NSW1.
    expect(body.series).toEqual([
      { key: 'NEM', coverage: 1, values: [0.9] },
      { key: 'NSW1', coverage: 1, values: [0.9] },
    ]);
  });

  it('FLOORS coverage — 0.99999 must never serve as a false 1.0', async () => {
    await seed([
      { scrapeTime: T0 + 300, generatorId: bw01, value: 99999 },
      { scrapeTime: T0 + 300, generatorId: TSTX1, value: 1 }, // unfactored sliver
    ]);
    const body = await (
      await get(`/api/v2/intensity?time_start=${T0}&time_end=${T0 + 300}&resolution=300`)
    ).json<IntensityBody>();
    expect(body.series.find((s) => s.key === 'NSW1')?.coverage).toBe(0.9999);
  });

  it('rejects an explicit fine resolution over a wide window (raw-path budget)', async () => {
    const wide = await get(`/api/v2/intensity?time_start=${T0}&time_end=${T0 + 15 * DAY}&resolution=300`);
    expect(wide.status).toBe(400);
    const wider = await get(`/api/v2/intensity?time_start=${T0}&time_end=${T0 + 91 * DAY}&resolution=1800`);
    expect(wider.status).toBe(400);
    // The same spans are fine at rollup resolutions, and 300 within budget is fine.
    expect((await get(`/api/v2/intensity?time_start=${T0}&time_end=${T0 + 91 * DAY}&resolution=86400`)).status).toBe(200);
    expect((await get(`/api/v2/intensity?time_start=${T0}&time_end=${T0 + 3 * DAY}&resolution=300`)).status).toBe(200);
  });

  it('applies generator filters (region narrows both the region series and the NEM total)', async () => {
    await seed([
      { scrapeTime: T0 + 300, generatorId: bw01, value: 100 },
      { scrapeTime: T0 + 300, generatorId: baps, value: 100 },
    ]);
    const body = await (
      await get(`/api/v2/intensity?region=VIC1&time_start=${T0}&time_end=${T0 + 300}&resolution=300`)
    ).json<IntensityBody>();
    expect(body.series).toEqual([
      { key: 'NEM', coverage: 1, values: [0] },
      { key: 'VIC1', coverage: 1, values: [0] },
    ]);
  });
});

describe('rollup-path intensity', () => {
  /** One full day, every interval covered, values positive and varying. */
  function fullDay(): Row[] {
    const rows: Row[] = [];
    for (let i = 1; i <= DAY / 300; i++) {
      const t = T0 + i * 300;
      rows.push({ scrapeTime: t, generatorId: bw01, value: 500 + (i % 13) });
      rows.push({ scrapeTime: t, generatorId: er01, value: 600 - (i % 17) });
      rows.push({ scrapeTime: t, generatorId: baps, value: 10 + (i % 7) });
    }
    return rows;
  }

  /** JS oracle: positive-only ratio-of-sums per (bucket, region) from the seeded rows. */
  function oracle(rows: Row[], resolution: number, factors: Map<number, number | null>) {
    const acc = new Map<string, { mw: number; mwF: number; em: number }>();
    for (const r of rows) {
      if (r.value <= 0) continue;
      const bucket = Math.ceil((r.scrapeTime + 36000) / resolution) * resolution - 36000;
      const region = r.generatorId === baps ? 'VIC1' : 'NSW1';
      for (const key of [`${bucket}|${region}`, `${bucket}|NEM`]) {
        const a = acc.get(key) ?? { mw: 0, mwF: 0, em: 0 };
        const f = factors.get(r.generatorId);
        a.mw += r.value;
        if (f !== null && f !== undefined) {
          a.mwF += r.value;
          a.em += r.value * f;
        }
        acc.set(key, a);
      }
    }
    return acc;
  }

  it('matches the positive-only ratio-of-sums oracle bucket-for-bucket at 3600 and 86400', async () => {
    const rows = fullDay();
    await seed(rows);
    const factors = new Map<number, number | null>([
      [bw01, 0.9],
      [er01, 0.8],
      [baps, 0],
    ]);

    for (const resolution of [HOUR, DAY]) {
      const body = await (
        await get(`/api/v2/intensity?time_start=${T0}&time_end=${T0 + DAY}&resolution=${resolution}`)
      ).json<IntensityBody>();
      expect(body.timestamps).toHaveLength(DAY / resolution);
      const expected = oracle(rows, resolution, factors);
      for (const s of body.series) {
        s.values.forEach((v, i) => {
          const e = expected.get(`${body.timestamps[i]}|${s.key}`);
          expect(e).toBeDefined();
          // The endpoint rounds to 4 dp; the oracle must too.
          expect(v).toBe(round4((e as { mwF: number; em: number }).em / (e as { mwF: number; em: number }).mwF));
        });
      }
    }
  });

  it('excludes a generator whose bucket net sum is negative (charging hour)', async () => {
    const rows: Row[] = [];
    for (let i = 1; i <= 12; i++) {
      rows.push({ scrapeTime: T0 + i * 300, generatorId: bw01, value: 100 });
      rows.push({ scrapeTime: T0 + i * 300, generatorId: TSTBAT1, value: -50 });
    }
    await seed(rows);
    const body = await (
      await get(`/api/v2/intensity?time_start=${T0}&time_end=${T0 + HOUR}&resolution=3600`)
    ).json<IntensityBody>();
    expect(body.series).toEqual([
      { key: 'NEM', coverage: 1, values: [0.9] },
      { key: 'NSW1', coverage: 1, values: [0.9] },
    ]);
  });

  it('routes 300/1800 and exact time= to raw rows, 3600/86400 to rollups', async () => {
    // Raw row WITHOUT a rollup refresh: whatever still answers is on the raw
    // path; whatever comes back empty is on the (empty) rollup tables.
    await upsertValues(env.DB, [{ scrapeTime: T0 + 300, generatorId: bw01, value: 100 }]);

    const fine = await (await get(`/api/v2/intensity?time_start=${T0}&time_end=${T0 + 300}&resolution=300`)).json<IntensityBody>();
    expect(fine.series.find((s) => s.key === 'NEM')?.values).toEqual([0.9]);

    const exact = await (await get(`/api/v2/intensity?time=${T0 + 300}&resolution=3600`)).json<IntensityBody>();
    expect(exact.series.find((s) => s.key === 'NEM')?.values).toEqual([0.9]);

    const hourly = await (
      await get(`/api/v2/intensity?time_start=${T0}&time_end=${T0 + HOUR}&resolution=3600`)
    ).json<IntensityBody>();
    expect(hourly.series).toEqual([]);
    expect(hourly.timestamps).toEqual([]);
  });
});

describe('intensity caching policy', () => {
  it('extends the closed test to the full edge bucket at rollup resolutions', () => {
    const end = T0 + DAY + 1800; // mid-bucket end → full daily bucket runs to T0 + 2*DAY
    const url = new URL(`https://nem.test/api/v2/intensity?time_start=${T0}&time_end=${end}&resolution=86400`);
    const bucketEnd = T0 + 2 * DAY;

    const before = buildCacheEntry(url, bucketEnd - 1);
    expect(before?.ttl).toBeLessThanOrEqual(300); // still open: boundary TTL
    const after = buildCacheEntry(url, bucketEnd + INGEST_GRACE_SECONDS);
    expect(after?.ttl).toBe(CLOSED_WINDOW_TTL_SECONDS);
  });

  it('keys carry window/resolution/filters but no paging parts', () => {
    const url = new URL(`https://nem.test/api/v2/intensity?time_start=${T0}&time_end=${T0 + 300}&region=SA1`);
    const entry = buildCacheEntry(url, T0 + DAY);
    expect(entry?.key).toContain('/api/v2/intensity');
    expect(entry?.key).toContain('state=SA1');
    expect(entry?.key).not.toContain('lim=');
    expect(entry?.key).not.toContain('ord=');
  });
});
