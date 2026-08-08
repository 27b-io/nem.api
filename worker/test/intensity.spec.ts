import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { refreshTouchedRollups, upsertValues } from '../src/ingest';
import worker from '../src/index';

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

// Seeded fixtures: BAPS = VIC1 Hydro, BW01 + ER01 = NSW1 Fossil.
let baps: number;
let bw01: number;
let er01: number;

interface IntensityBody {
  start: number | null;
  end: number | null;
  resolution: number;
  unit: string;
  truncated: boolean;
  timestamps: number[];
  series: Array<{ key: string; values: (number | null)[]; coverage: (number | null)[]; official?: (number | null)[] }>;
}

async function intensity(query: string): Promise<IntensityBody> {
  const res = await get(`/api/v2/intensity?${query}`);
  expect(res.status).toBe(200);
  return res.json<IntensityBody>();
}

function seriesOf(body: IntensityBody, key: string) {
  const s = body.series.find((x) => x.key === key);
  if (!s) throw new Error(`no series ${key} in ${body.series.map((x) => x.key).join(', ')}`);
  return s;
}

async function seed(rows: Array<{ scrapeTime: number; generatorId: number; value: number }>): Promise<void> {
  await upsertValues(env.DB, rows);
  await refreshTouchedRollups(env.DB, rows);
}

async function setFactors(entries: Array<[duid: string, factor: number]>): Promise<void> {
  for (const [duid, factor] of entries) {
    await env.DB.prepare("INSERT INTO emission_factors (duid, factor, data_source) VALUES (?, ?, 'TEST')")
      .bind(duid, factor)
      .run();
  }
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM scada_values').run();
  await env.DB.prepare('DELETE FROM scada_hourly').run();
  await env.DB.prepare('DELETE FROM scada_daily').run();
  await env.DB.prepare('DELETE FROM scada_intervals').run();
  await env.DB.prepare('DELETE FROM emission_factors').run();
  await env.DB.prepare('DELETE FROM cdeii_daily').run();
  host = `t-${crypto.randomUUID()}.test`;
  baps = await gidOf('BAPS');
  bw01 = await gidOf('BW01');
  er01 = await gidOf('ER01');
});

describe('/api/v2/intensity', () => {
  it('is energy-weighted per region, and NEM is the ratio of sums — not the mean of regional intensities', async () => {
    await setFactors([
      ['BW01', 0.9],
      ['ER01', 0.8],
      ['BAPS', 0],
    ]);
    await seed([
      { scrapeTime: T0 + 300, generatorId: bw01, value: 100 },
      { scrapeTime: T0 + 300, generatorId: er01, value: 100 },
      { scrapeTime: T0 + 300, generatorId: baps, value: 50 },
    ]);

    const body = await intensity(`time=${T0 + 300}`);
    expect(body.unit).toBe('tCO2-e/MWh');
    expect(body.timestamps).toEqual([T0 + 300]);

    // (100*0.9 + 100*0.8) / 200
    expect(seriesOf(body, 'NSW1').values).toEqual([0.85]);
    expect(seriesOf(body, 'VIC1').values).toEqual([0]);
    // (90 + 80 + 0) / 250 = 0.68. The unweighted mean of the two regions would
    // be 0.425 — a quiet Tasmania must not weigh like a loaded NSW.
    expect(seriesOf(body, 'NEM').values).toEqual([0.68]);
    // NEM is always first: the dashboard's default and the reading order.
    expect(body.series[0].key).toBe('NEM');
  });

  it('excludes generation with no published factor from the ratio and discloses the shortfall as coverage', async () => {
    await setFactors([['BW01', 0.9]]); // ER01 deliberately unfactored
    await seed([
      { scrapeTime: T0 + 300, generatorId: bw01, value: 100 },
      { scrapeTime: T0 + 300, generatorId: er01, value: 100 },
    ]);

    const nsw = seriesOf(await intensity(`time=${T0 + 300}`), 'NSW1');
    // Treating the unfactored 100 MW as zero-emission would read 0.45 — the
    // exact silent lie the coverage field exists to prevent.
    expect(nsw.values).toEqual([0.9]);
    expect(nsw.coverage).toEqual([0.5]);
  });

  it('reports full coverage and a real intensity when every generator is factored', async () => {
    await setFactors([
      ['BW01', 0.9],
      ['ER01', 0.9],
    ]);
    await seed([
      { scrapeTime: T0 + 300, generatorId: bw01, value: 100 },
      { scrapeTime: T0 + 300, generatorId: er01, value: 100 },
    ]);
    expect(seriesOf(await intensity(`time=${T0 + 300}`), 'NSW1').coverage).toEqual([1]);
  });

  it('clamps a net-consuming generator out of both halves of the ratio', async () => {
    await setFactors([
      ['BW01', 0.9],
      ['ER01', 0], // stand-in for a zero-emission unit that is charging
    ]);
    await seed([
      { scrapeTime: T0 + 300, generatorId: bw01, value: 100 },
      { scrapeTime: T0 + 300, generatorId: er01, value: -40 },
    ]);

    const nsw = seriesOf(await intensity(`time=${T0 + 300}`), 'NSW1');
    // Netting the -40 into the denominator would read 90/60 = 1.5 — intensity
    // inflated by 67%, and worst exactly when the grid is cleanest.
    expect(nsw.values).toEqual([0.9]);
    expect(nsw.coverage).toEqual([1]);
  });

  it('clamps on the per-generator NET of a bucket, so the rule is resolution-visible and documented', async () => {
    await setFactors([
      ['BW01', 1],
      ['ER01', 0],
    ]);
    // ER01 charges hard, then discharges: net -20 MW across the hour.
    await seed([
      { scrapeTime: T0 + 300, generatorId: bw01, value: 100 },
      { scrapeTime: T0 + 600, generatorId: bw01, value: 100 },
      { scrapeTime: T0 + 300, generatorId: er01, value: -50 },
      { scrapeTime: T0 + 600, generatorId: er01, value: 30 },
    ]);

    // At 5-minute grain a bucket IS one interval, so the rule reduces to
    // "drop negative readings": the +30 discharge interval counts.
    const fine = await intensity(`time_start=${T0 + 300}&time_end=${T0 + 600}&resolution=300`);
    expect(seriesOf(fine, 'NSW1').values).toEqual([1, 0.7692]); // 100/130, to the contract's 4 dp

    // At hourly grain ER01 is a net consumer over the whole bucket, so it
    // contributes nothing at all.
    const hourly = await intensity(`time_start=${T0 + 300}&time_end=${T0 + HOUR}&resolution=3600`);
    expect(seriesOf(hourly, 'NSW1').values).toEqual([1]);
  });

  it('reports null — not zero — for a bucket with no covered generation', async () => {
    await setFactors([['BW01', 0.9]]);
    await seed([{ scrapeTime: T0 + 300, generatorId: er01, value: 100 }]); // unfactored only

    const nsw = seriesOf(await intensity(`time=${T0 + 300}`), 'NSW1');
    expect(nsw.values).toEqual([null]);
    expect(nsw.coverage).toEqual([0]);
  });

  it('serves long windows from the rollups with the identical number the raw rows give', async () => {
    await setFactors([
      ['BW01', 0.9],
      ['ER01', 0.4],
      ['BAPS', 0],
    ]);
    // A full day of 5-minute rows with a varying profile, so a rollup that
    // merely approximated the raw math would drift visibly.
    const rows = [];
    for (let i = 1; i <= 288; i++) {
      const t = T0 + i * 300;
      rows.push({ scrapeTime: t, generatorId: bw01, value: 300 + (i % 17) * 10 });
      rows.push({ scrapeTime: t, generatorId: er01, value: 100 + (i % 7) * 25 });
      rows.push({ scrapeTime: t, generatorId: baps, value: 60 - (i % 5) * 30 }); // dips negative
    }
    await seed(rows);

    // Oracle: the documented expression evaluated over the RAW rows, in JS.
    const perGenerator = new Map<number, number>();
    for (const r of rows) perGenerator.set(r.generatorId, (perGenerator.get(r.generatorId) ?? 0) + r.value);
    const factorOf = new Map([
      [bw01, 0.9],
      [er01, 0.4],
      [baps, 0],
    ]);
    let num = 0;
    let den = 0;
    for (const [gid, sum] of perGenerator) {
      const mw = Math.max(sum, 0);
      num += mw * (factorOf.get(gid) as number);
      den += mw;
    }
    const expected = Math.round((num / den) * 1e4) / 1e4;

    // resolution 86400 is served from scada_daily (the rollup path).
    const daily = await intensity(`time_start=${T0}&time_end=${T0 + DAY}&resolution=86400`);
    expect(daily.timestamps).toEqual([T0 + DAY]);
    expect(seriesOf(daily, 'NEM').values).toEqual([expected]);
  });

  it('republishes AEMO official daily index alongside the estimate, at daily grain only', async () => {
    await setFactors([
      ['BW01', 0.9],
      ['BAPS', 0],
    ]);
    await seed([
      { scrapeTime: T0 + 300, generatorId: bw01, value: 100 },
      { scrapeTime: T0 + 300, generatorId: baps, value: 100 },
    ]);
    // AEMO keys its index to the AEST midnight that STARTS the day; our daily
    // bucket for that day is period-ending, one day later.
    await env.DB.prepare(
      'INSERT INTO cdeii_daily (settlement_date, region, sent_out_energy, emissions, intensity) VALUES (?,?,?,?,?)',
    )
      .bind(T0, 'NSW1', 1000, 850, 0.85)
      .run();

    const daily = await intensity(`time_start=${T0}&time_end=${T0 + DAY}&resolution=86400`);
    expect(daily.timestamps).toEqual([T0 + DAY]);
    expect(seriesOf(daily, 'NSW1').official).toEqual([0.85]);
    expect(seriesOf(daily, 'VIC1').official).toEqual([null]); // no official row for VIC1

    // Sub-daily buckets have no official counterpart, so the field is absent
    // rather than a column of nulls.
    const hourly = await intensity(`time_start=${T0}&time_end=${T0 + HOUR}&resolution=3600`);
    expect(seriesOf(hourly, 'NSW1').official).toBeUndefined();
  });

  it('reconciles the estimate against the official index within the published tolerance', async () => {
    // The reconciliation harness in miniature: same comparison
    // scripts/reconcile-cdeii.mjs runs against production, so the gate itself
    // is under test rather than living only in a script.
    await setFactors([['BW01', 0.9]]);
    await seed(
      Array.from({ length: 288 }, (_, i) => ({ scrapeTime: T0 + (i + 1) * 300, generatorId: bw01, value: 100 })),
    );
    await env.DB.prepare(
      'INSERT INTO cdeii_daily (settlement_date, region, sent_out_energy, emissions, intensity) VALUES (?,?,?,?,?)',
    )
      .bind(T0, 'NSW1', 1000, 860, 0.86)
      .run();

    const nsw = seriesOf(await intensity(`time_start=${T0}&time_end=${T0 + DAY}&resolution=86400`), 'NSW1');
    const [ours] = nsw.values;
    const [official] = nsw.official as number[];
    expect(ours).toBe(0.9);
    // As-generated vs sent-out puts us a few percent high, by construction.
    expect(Math.abs((ours as number) - official) / official).toBeLessThan(0.1);
  });

  it('rejects malformed parameters instead of silently coercing them', async () => {
    expect((await get('/api/v2/intensity?resolution=77')).status).toBe(400);
    expect((await get('/api/v2/intensity?hours=nope')).status).toBe(400);
  });

  it('ignores generator filters — intensity is defined per region, so a fuel subset would be a wrong number', async () => {
    await setFactors([
      ['BW01', 0.9],
      ['BAPS', 0],
    ]);
    await seed([
      { scrapeTime: T0 + 300, generatorId: bw01, value: 100 },
      { scrapeTime: T0 + 300, generatorId: baps, value: 100 },
    ]);

    const filtered = await intensity(`time=${T0 + 300}&fuel=Hydro&region=VIC1`);
    expect(filtered.series.map((s) => s.key).sort()).toEqual(['NEM', 'NSW1', 'VIC1']);
    expect(seriesOf(filtered, 'NEM').values).toEqual([0.45]);
  });
});
