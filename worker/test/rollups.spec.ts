import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { refreshTouchedRollups, upsertValues } from '../src/ingest';
import worker from '../src/index';
import { refreshRollups } from '../src/rollups';

// T0 = 2026-07-25 00:00 AEST — an AEST midnight AND an hour boundary, so both
// hourly and daily bucket expectations are exact. Period-ENDING everywhere.
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
    .first<{ id: number }>();
  if (!row) throw new Error(`no generator seeded for DUID ${duid}`);
  return row.id;
}

// Seeded fixtures: BAPS = VIC1 Hydro/Water, BW01 + ER01 = NSW1 Fossil/Black Coal.
let baps: number;
let bw01: number;
let er01: number;

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

interface AggregateBody {
  start: number | null;
  end: number | null;
  resolution: number;
  truncated: boolean;
  timestamps: number[];
  series: Array<{ key: string; values: (number | null)[] }>;
}

interface Triple {
  bucket: number;
  grp: string;
  value: number;
}

/** Flatten a columnar aggregate body back to sorted (bucket, group, value) triples. */
function flatten(body: AggregateBody): Triple[] {
  const out: Triple[] = [];
  for (const s of body.series) {
    s.values.forEach((v, i) => {
      if (v !== null) out.push({ bucket: body.timestamps[i], grp: s.key, value: v });
    });
  }
  return out.sort((a, b) => a.bucket - b.bucket || (a.grp < b.grp ? -1 : a.grp > b.grp ? 1 : 0));
}

/**
 * The PRE-rollup aggregate SQL (the raw-row path), run directly against D1:
 * the reference the rollup path must numerically match on windows where a
 * group has samples in every interval of every bucket.
 */
async function rawAggregate(
  groupColumn: string,
  start: number,
  end: number,
  resolution: number,
  filterSql = '',
  filterBinds: (string | number)[] = [],
): Promise<Triple[]> {
  const off = 36000;
  const sql =
    `SELECT ((t + ${off + resolution - 1}) / ${resolution}) * ${resolution} - ${off} AS bucket, grp, ` +
    'ROUND(AVG(total), 4) AS value FROM (' +
    `SELECT sv.scrape_time AS t, COALESCE(g.${groupColumn}, '') AS grp, SUM(sv.value) AS total ` +
    'FROM scada_values sv JOIN generators g ON g.id = sv.generator_id ' +
    `WHERE sv.scrape_time >= ? AND sv.scrape_time <= ? ${filterSql} GROUP BY t, grp` +
    ') GROUP BY bucket, grp ORDER BY bucket ASC, grp ASC';
  const { results } = await env.DB.prepare(sql)
    .bind(start, end, ...filterBinds)
    .all<Triple>();
  return results;
}

function expectTriplesClose(actual: Triple[], expected: Triple[]): void {
  expect(actual.map((t) => ({ bucket: t.bucket, grp: t.grp }))).toEqual(
    expected.map((t) => ({ bucket: t.bucket, grp: t.grp })),
  );
  actual.forEach((t, i) => expect(t.value).toBeCloseTo(expected[i].value, 6));
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM scada_values'),
    env.DB.prepare('DELETE FROM scada_hourly'),
    env.DB.prepare('DELETE FROM scada_daily'),
    env.DB.prepare('DELETE FROM scada_intervals'),
    env.DB.prepare('DELETE FROM generators WHERE id >= 9000'),
  ]);
  host = `t-${crypto.randomUUID()}.test`;
  baps = await gidOf('BAPS');
  bw01 = await gidOf('BW01');
  er01 = await gidOf('ER01');
});

describe('rollup path equivalence with the raw-row path', () => {
  // Two full days, every interval covered for every generator (the production
  // norm — each registered DUID reports every dispatch interval), integer
  // values with negatives sprinkled so sums are float-exact.
  function twoDays(): Row[] {
    const rows: Row[] = [];
    for (let i = 1; i <= (2 * DAY) / 300; i++) {
      const t = T0 + i * 300;
      rows.push({ scrapeTime: t, generatorId: baps, value: ((i * 7) % 40) - 10 });
      rows.push({ scrapeTime: t, generatorId: bw01, value: 500 + (i % 13) });
      rows.push({ scrapeTime: t, generatorId: er01, value: 600 - (i % 17) });
    }
    return rows;
  }

  it('matches raw hourly aggregates bucket-for-bucket (group_by=fuel)', async () => {
    await seed(twoDays());
    const res = await get(
      `/api/v2/values/aggregate?group_by=fuel&time_start=${T0}&time_end=${T0 + 2 * DAY}&resolution=3600`,
    );
    expect(res.status).toBe(200);
    const body = await res.json<AggregateBody>();
    expect(body.timestamps).toHaveLength(48);
    expectTriplesClose(flatten(body), await rawAggregate('fuel_type', T0, T0 + 2 * DAY, HOUR));
  });

  it('matches raw daily aggregates (group_by=fuel, resolution=86400)', async () => {
    await seed(twoDays());
    const body = await (
      await get(`/api/v2/values/aggregate?group_by=fuel&time_start=${T0}&time_end=${T0 + 2 * DAY}&resolution=86400`)
    ).json<AggregateBody>();
    expect(body.timestamps).toEqual([T0 + DAY, T0 + 2 * DAY]);
    expectTriplesClose(flatten(body), await rawAggregate('fuel_type', T0, T0 + 2 * DAY, DAY));
  });

  it('matches raw daily aggregates with group_by=region and a fuel filter', async () => {
    await seed(twoDays());
    const body = await (
      await get(
        `/api/v2/values/aggregate?group_by=region&fuel=Fossil&time_start=${T0}&time_end=${T0 + 2 * DAY}&resolution=86400`,
      )
    ).json<AggregateBody>();
    expect(body.series.map((s) => s.key)).toEqual(['NSW1']);
    expectTriplesClose(
      flatten(body),
      await rawAggregate('state', T0, T0 + 2 * DAY, DAY, 'AND g.fuel_type = ?', ['Fossil']),
    );
  });
});

describe('rollup maintenance', () => {
  it('reflects a new interval in the latest hourly and daily buckets after an ingest tick', async () => {
    // A seeded hour, then one more 5-minute tick exactly as ingestFile does.
    await seed(Array.from({ length: 12 }, (_, i) => ({ scrapeTime: T0 + (i + 1) * 300, generatorId: baps, value: 6 })));
    await seed([{ scrapeTime: T0 + HOUR + 300, generatorId: baps, value: 60 }]);

    const hourly = await env.DB.prepare('SELECT sum_value, n_samples FROM scada_hourly WHERE bucket = ? AND generator_id = ?')
      .bind(T0 + 2 * HOUR, baps)
      .first<{ sum_value: number; n_samples: number }>();
    expect(hourly).toEqual({ sum_value: 60, n_samples: 1 });

    const daily = await env.DB.prepare('SELECT sum_value, n_samples FROM scada_daily WHERE bucket = ? AND generator_id = ?')
      .bind(T0 + DAY, baps)
      .first<{ sum_value: number; n_samples: number }>();
    expect(daily).toEqual({ sum_value: 12 * 6 + 60, n_samples: 13 });

    // And it is live through the API: the partial current hour averages the
    // intervals ingested so far, same as the raw path would.
    const body = await (
      await get(`/api/v2/values/aggregate?group_by=fuel&time_start=${T0}&time_end=${T0 + 2 * HOUR}&resolution=3600`)
    ).json<AggregateBody>();
    expect(body.timestamps).toEqual([T0 + HOUR, T0 + 2 * HOUR]);
    expect(body.series).toEqual([{ key: 'Hydro', values: [6, 60] }]);
  });

  it('recomputes (not increments) when a re-ingest overwrites a value', async () => {
    await seed([{ scrapeTime: T0 + 300, generatorId: baps, value: 100 }]);
    await seed([{ scrapeTime: T0 + 300, generatorId: baps, value: 50 }]);

    const hourly = await env.DB.prepare('SELECT sum_value, n_samples FROM scada_hourly WHERE bucket = ? AND generator_id = ?')
      .bind(T0 + HOUR, baps)
      .first<{ sum_value: number; n_samples: number }>();
    expect(hourly).toEqual({ sum_value: 50, n_samples: 1 });
  });
});

describe('rollup path semantics', () => {
  it('nets negatives through and keeps NULL group values as the "" series', async () => {
    await env.DB.prepare(
      "INSERT INTO generators (id, name, participant_name, duid, state) VALUES (9001, 'Test Battery', 'Test', 'TSTBAT1', 'SA1')",
    ).run();
    await seed([
      { scrapeTime: T0 + 300, generatorId: 9001, value: -5 }, // charging: negative, NULL fuel_type
      { scrapeTime: T0 + 600, generatorId: 9001, value: -7 },
      { scrapeTime: T0 + 300, generatorId: baps, value: 10 },
      { scrapeTime: T0 + 600, generatorId: baps, value: 20 },
    ]);

    const body = await (
      await get(`/api/v2/values/aggregate?group_by=fuel&time_start=${T0}&time_end=${T0 + DAY}&resolution=86400`)
    ).json<AggregateBody>();
    expect(body.timestamps).toEqual([T0 + DAY]);
    expect(body.series).toEqual([
      { key: '', values: [-6] },
      { key: 'Hydro', values: [15] },
    ]);
  });

  it('averages a group missing intervals over the FULL interval count (missing = 0 MW)', async () => {
    // bw01 reports all 12 intervals of the hour; baps only the first 6.
    // Documented rollup-path semantics (see src/api.ts): Hydro's mean is
    // 6×10/12 = 5, not the raw path's mean-over-present-intervals 10 — the
    // energy-correct reading for a unit offline half the bucket.
    const rows: Row[] = [];
    for (let i = 1; i <= 12; i++) {
      rows.push({ scrapeTime: T0 + i * 300, generatorId: bw01, value: 600 });
      if (i <= 6) rows.push({ scrapeTime: T0 + i * 300, generatorId: baps, value: 10 });
    }
    await seed(rows);

    const body = await (
      await get(`/api/v2/values/aggregate?group_by=fuel&time_start=${T0}&time_end=${T0 + HOUR}&resolution=3600`)
    ).json<AggregateBody>();
    expect(body.series).toEqual([
      { key: 'Fossil', values: [600] },
      { key: 'Hydro', values: [5] },
    ]);
  });
});

describe('query routing', () => {
  it('serves 300/1800 and exact-time lookups from raw rows, 3600/86400 from rollups', async () => {
    // Raw rows WITHOUT a rollup refresh: whatever still answers is on the raw
    // path; whatever comes back empty is on the (empty) rollup tables.
    await upsertValues(env.DB, [{ scrapeTime: T0 + 300, generatorId: baps, value: 10 }]);
    const q = (extra: string) => `/api/v2/values/aggregate?group_by=fuel&${extra}`;

    const fine = await (await get(q(`time_start=${T0}&time_end=${T0 + 300}&resolution=1800`))).json<AggregateBody>();
    expect(fine.series).toEqual([{ key: 'Hydro', values: [10] }]);

    const exact = await (await get(q(`time=${T0 + 300}&resolution=3600`))).json<AggregateBody>();
    expect(exact.series).toEqual([{ key: 'Hydro', values: [10] }]);

    const hourly = await (await get(q(`time_start=${T0}&time_end=${T0 + HOUR}&resolution=3600`))).json<AggregateBody>();
    expect(hourly.series).toEqual([]);

    await refreshRollups(env.DB, T0 + 300, T0 + 300);
    // Fresh host: the (fully-past, hence cached) empty response above must not
    // be served back for the re-query — cache keys include the request host.
    host = `t-${crypto.randomUUID()}.test`;
    const rolled = await (await get(q(`time_start=${T0}&time_end=${T0 + HOUR}&resolution=3600`))).json<AggregateBody>();
    expect(rolled.series).toEqual([{ key: 'Hydro', values: [10] }]);
  });
});
