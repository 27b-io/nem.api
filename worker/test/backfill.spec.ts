import { env } from 'cloudflare:test';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ingestBundle, runBackfill } from '../src/backfill';
import { DISPATCH_IS_FEED, ROOFTOP_FEED, SCADA_FEED } from '../src/ingest';

// Tests run in the same isolate as the code under test, so stubbing global
// fetch covers the module's outbound HTTP (bindings like D1/R2 don't route
// through fetch). Any URL without a registered route throws — "did not
// re-download" assertions below are real proofs, not absence of evidence.
let routes: Map<string, () => Response>;
beforeEach(async () => {
  // vitest-pool-workers gives each test FILE its own runtime + storage, but
  // tests within a file share state — reset what these tests mutate.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM scada_values'),
    env.DB.prepare('DELETE FROM scada_hourly'),
    env.DB.prepare('DELETE FROM scada_daily'),
    env.DB.prepare('DELETE FROM scada_intervals'),
    env.DB.prepare('DELETE FROM dispatch_region'),
    env.DB.prepare('DELETE FROM dispatch_interconnector'),
    env.DB.prepare('DELETE FROM rooftop_pv'),
    env.DB.prepare('DELETE FROM scrape'),
  ]);
  const archived = await env.ARCHIVE.list({ prefix: 'archive/' });
  await Promise.all(archived.objects.map((o) => env.ARCHIVE.delete(o.key)));

  routes = new Map();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const handler = routes.get(url);
    if (!handler) throw new Error(`unexpected fetch: ${url}`);
    return handler();
  });
});
afterEach(() => vi.unstubAllGlobals());

const LISTING_URL = 'https://nemweb.com.au/Reports/ARCHIVE/Dispatch_SCADA/';

// EILDON1/EILDON2 are in the generator seed; FAKESF1 is deliberately not.
const KNOWN_DUIDS: [string, number][] = [
  ['EILDON1', 42.5],
  ['EILDON2', 10.0],
];

function settlement(date: string, i: number): string {
  const mins = (i + 1) * 5;
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  return `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6, 8)} ${hh}:${mm}:00`;
}

function intervalCsv(date: string, i: number, rows: [string, number][]): string {
  const ts = settlement(date, i);
  return [
    `C,NEMP.WORLD,DISPATCHSCADA,AEMO,PUBLIC,${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6, 8)},00:00:00,1,DISPATCHSCADA,1`,
    'I,DISPATCH,UNIT_SCADA,1,SETTLEMENTDATE,DUID,SCADAVALUE,LASTCHANGED',
    ...rows.map(([duid, v]) => `D,DISPATCH,UNIT_SCADA,1,"${ts}",${duid},${v},"${ts}"`),
    '',
  ].join('\r\n');
}

/** Build a daily zip-of-zips like the real ARCHIVE files, `intervals` inner five-minute zips. */
function buildDailyZip(date: string, intervals: number, rows: [string, number][] = KNOWN_DUIDS): Uint8Array {
  const inner: Record<string, Uint8Array> = {};
  for (let i = 0; i < intervals; i++) {
    const ts = settlement(date, i).replace(/[/ :]/g, '').slice(0, 12);
    const name = `PUBLIC_DISPATCHSCADA_${ts}_00000000000000${String(i).padStart(2, '0')}`;
    inner[`${name}.zip`] = zipSync({ [`${name}.CSV`]: strToU8(intervalCsv(date, i, rows)) });
  }
  return zipSync(inner);
}

function listingHtml(dates: string[]): string {
  const links = dates
    .map(
      (d) =>
        `<A HREF="/Reports/ARCHIVE/Dispatch_SCADA/PUBLIC_DISPATCHSCADA_${d}.zip">PUBLIC_DISPATCHSCADA_${d}.zip</A><br>`,
    )
    .join('\n');
  return `<html><body><pre><A HREF="/Reports/ARCHIVE">[To Parent Directory]</A><br>\n${links}</pre></body></html>`;
}

function interceptListing(dates: string[]): void {
  routes.set(LISTING_URL, () => new Response(listingHtml(dates), { headers: { 'content-type': 'text/html' } }));
}

function interceptDaily(date: string, zip: Uint8Array): void {
  routes.set(`${LISTING_URL}PUBLIC_DISPATCHSCADA_${date}.zip`, () => new Response(zip));
}

async function valueCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT count(*) AS n FROM scada_values').first<{ n: number }>();
  return row?.n ?? 0;
}

async function ledgerFilenames(): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT filename FROM scrape ORDER BY filename').all<{
    filename: string;
  }>();
  return results.map((r) => r.filename);
}

describe('runBackfill', () => {
  it('ingests listed daily archives end to end: D1 values, R2 raw zip, ledger', async () => {
    const dates = ['20260101', '20260102'];
    interceptListing(dates);
    for (const d of dates) interceptDaily(d, buildDailyZip(d, 3, [...KNOWN_DUIDS, ['FAKESF1', 1.0]]));

    const run = await runBackfill(env, SCADA_FEED);
    expect(run).toEqual({ ok: 2, failed: 0, values: 12, remaining: 0 });

    // 2 days × 3 intervals × 2 known DUIDs; the unknown FAKESF1 rows dropped.
    expect(await valueCount()).toBe(12);

    // Settlement "2026/01/01 00:05:00" is NEM market time (UTC+10).
    const expected = Date.UTC(2026, 0, 1, 0, 5, 0) / 1000 - 10 * 3600;
    const eildon1 = await env.DB.prepare(
      'SELECT value FROM scada_values v JOIN generators g ON g.id = v.generator_id ' +
        "WHERE g.duid = 'EILDON1' AND v.scrape_time = ?",
    )
      .bind(expected)
      .first<{ value: number }>();
    expect(eildon1?.value).toBe(42.5);

    for (const d of dates) {
      expect(await env.ARCHIVE.head(`archive/PUBLIC_DISPATCHSCADA_${d}.zip`)).not.toBeNull();
    }
    expect(await ledgerFilenames()).toEqual(dates.map((d) => `PUBLIC_DISPATCHSCADA_${d}.zip`));

    // Rollups (LAB-1696) are maintained by the same run: scada_hourly must be
    // exactly a whole-bucket recomputation of what landed in scada_values —
    // no bucket missing, none stale, sums and counts equal.
    const drift = await env.DB.prepare(
      'SELECT count(*) AS n FROM (' +
        'SELECT ((scrape_time + 39599) / 3600) * 3600 - 36000 AS b, generator_id AS gid, ' +
        'SUM(value) AS s, COUNT(*) AS c FROM scada_values GROUP BY b, gid' +
        ') x LEFT JOIN scada_hourly h ON h.bucket = x.b AND h.generator_id = x.gid ' +
        'WHERE h.bucket IS NULL OR abs(h.sum_value - x.s) > 1e-9 OR h.n_samples != x.c',
    ).first<{ n: number }>();
    expect(drift?.n).toBe(0);
    const counts = await env.DB.prepare(
      'SELECT (SELECT count(*) FROM scada_hourly) AS hourly, ' +
        '(SELECT count(DISTINCT ((scrape_time + 39599) / 3600) * 3600) FROM scada_values) AS buckets, ' +
        '(SELECT sum(n_intervals) FROM scada_intervals) AS intervals',
    ).first<{ hourly: number; buckets: number; intervals: number }>();
    // 2 days × 3 intervals inside one hour each → 2 hourly buckets × 2 DUIDs.
    expect(counts).toEqual({ hourly: 4, buckets: 2, intervals: 6 });
  });

  it('is resumable: ledgered days are skipped without any zip fetch', async () => {
    await env.DB.prepare("INSERT INTO scrape (filename, ingested_at) VALUES ('PUBLIC_DISPATCHSCADA_20260101.zip', 1)")
      .run();
    interceptListing(['20260101', '20260102']);
    interceptDaily('20260102', buildDailyZip('20260102', 2)); // no interceptor for 20260101 — a fetch would fail

    const run = await runBackfill(env, SCADA_FEED);
    expect(run).toEqual({ ok: 1, failed: 0, values: 4, remaining: 0 });

    // Fully idle second pass: nothing fetched beyond the listing, nothing failed.
    interceptListing(['20260101', '20260102']);
    expect(await runBackfill(env, SCADA_FEED)).toEqual({ ok: 0, failed: 0, values: 0, remaining: 0 });
  });

  it('five-minute CURRENT ledger entries do not mask a daily archive', async () => {
    // The same date's CURRENT files interleave lexicographically with the
    // daily name; the ledger diff must only match daily-shaped filenames.
    await env.DB.prepare(
      "INSERT INTO scrape (filename, ingested_at) VALUES ('PUBLIC_DISPATCHSCADA_202601010005_0000000000000001.zip', 1)",
    ).run();
    interceptListing(['20260101']);
    interceptDaily('20260101', buildDailyZip('20260101', 2));

    const run = await runBackfill(env, SCADA_FEED);
    expect(run.ok).toBe(1);
    expect(await ledgerFilenames()).toContain('PUBLIC_DISPATCHSCADA_20260101.zip');
  });

  it('reads a previously archived day from R2 instead of re-downloading', async () => {
    await env.ARCHIVE.put('archive/PUBLIC_DISPATCHSCADA_20260101.zip', buildDailyZip('20260101', 2));
    interceptListing(['20260101']); // no zip interceptor — NEMWEB fetch would throw

    const run = await runBackfill(env, SCADA_FEED);
    expect(run).toEqual({ ok: 1, failed: 0, values: 4, remaining: 0 });
    expect(await ledgerFilenames()).toEqual(['PUBLIC_DISPATCHSCADA_20260101.zip']);
  });
});

describe('runBackfill — DispatchIS feed (LAB-1700)', () => {
  const DIS_LISTING = 'https://nemweb.com.au/Reports/Archive/DispatchIS_Reports/';

  function dispatchIsCsv(date: string, i: number): string {
    const ts = settlement(date, i);
    return [
      `C,NEMP.WORLD,DISPATCHIS,AEMO,PUBLIC,${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6, 8)},00:00:00,1,DISPATCHIS,1`,
      'I,DISPATCH,PRICE,5,SETTLEMENTDATE,RUNNO,REGIONID,DISPATCHINTERVAL,INTERVENTION,RRP',
      `D,DISPATCH,PRICE,5,"${ts}",1,NSW1,1,0,110.5`,
      `D,DISPATCH,PRICE,5,"${ts}",1,SA1,1,0,-8.5`,
      'I,DISPATCH,REGIONSUM,9,SETTLEMENTDATE,RUNNO,REGIONID,DISPATCHINTERVAL,INTERVENTION,TOTALDEMAND',
      `D,DISPATCH,REGIONSUM,9,"${ts}",1,NSW1,1,0,9000`,
      `D,DISPATCH,REGIONSUM,9,"${ts}",1,SA1,1,0,1700`,
      'I,DISPATCH,INTERCONNECTORRES,3,SETTLEMENTDATE,RUNNO,INTERCONNECTORID,DISPATCHINTERVAL,INTERVENTION,METEREDMWFLOW',
      `D,DISPATCH,INTERCONNECTORRES,3,"${ts}",1,V-SA,1,0,-79.3`,
      '',
    ].join('\r\n');
  }

  function buildDispatchIsDaily(date: string, intervals: number): Uint8Array {
    const inner: Record<string, Uint8Array> = {};
    for (let i = 0; i < intervals; i++) {
      const ts = settlement(date, i).replace(/[/ :]/g, '').slice(0, 12);
      const name = `PUBLIC_DISPATCHIS_${ts}_00000000000000${String(i).padStart(2, '0')}`;
      inner[`${name}.zip`] = zipSync({ [`${name}.CSV`]: strToU8(dispatchIsCsv(date, i)) });
    }
    return zipSync(inner);
  }

  it('ingests a DispatchIS daily archive end to end: D1 rows, R2 raw zip, ledger', async () => {
    routes.set(DIS_LISTING, () => new Response(
      '<html><body><pre>' +
        '<A HREF="/Reports/Archive/DispatchIS_Reports/PUBLIC_DISPATCHIS_20260101.zip">PUBLIC_DISPATCHIS_20260101.zip</A><br>' +
        '</pre></body></html>',
      { headers: { 'content-type': 'text/html' } },
    ));
    routes.set(`${DIS_LISTING}PUBLIC_DISPATCHIS_20260101.zip`, () => new Response(buildDispatchIsDaily('20260101', 3)));

    const run = await runBackfill(env, DISPATCH_IS_FEED);
    // 3 intervals × (2 region rows + 1 interconnector row).
    expect(run).toEqual({ ok: 1, failed: 0, values: 9, remaining: 0 });

    const expected = Date.UTC(2026, 0, 1, 0, 5, 0) / 1000 - 10 * 3600;
    const nsw = await env.DB.prepare(
      "SELECT rrp, total_demand FROM dispatch_region WHERE settlement_time = ? AND region = 'NSW1'",
    )
      .bind(expected)
      .first<{ rrp: number; total_demand: number }>();
    expect(nsw).toEqual({ rrp: 110.5, total_demand: 9000 });
    const flow = await env.DB.prepare(
      "SELECT metered_mw_flow FROM dispatch_interconnector WHERE settlement_time = ? AND interconnector = 'V-SA'",
    )
      .bind(expected)
      .first<{ metered_mw_flow: number }>();
    expect(flow?.metered_mw_flow).toBe(-79.3);

    expect(await env.ARCHIVE.head('archive/PUBLIC_DISPATCHIS_20260101.zip')).not.toBeNull();
    expect(await ledgerFilenames()).toEqual(['PUBLIC_DISPATCHIS_20260101.zip']);
  });

  it("one feed's ledger entries never mask the other's dailies for the same date", async () => {
    // A SCADA daily for the same date sorts inside the DispatchIS range scan;
    // the per-feed GLOB must keep them apart.
    await env.DB.prepare("INSERT INTO scrape (filename, ingested_at) VALUES ('PUBLIC_DISPATCHSCADA_20260101.zip', 1)")
      .run();
    routes.set(DIS_LISTING, () => new Response(
      '<html><body><pre>' +
        '<A HREF="/Reports/Archive/DispatchIS_Reports/PUBLIC_DISPATCHIS_20260101.zip">PUBLIC_DISPATCHIS_20260101.zip</A><br>' +
        '</pre></body></html>',
      { headers: { 'content-type': 'text/html' } },
    ));
    routes.set(`${DIS_LISTING}PUBLIC_DISPATCHIS_20260101.zip`, () => new Response(buildDispatchIsDaily('20260101', 2)));

    const run = await runBackfill(env, DISPATCH_IS_FEED);
    expect(run.ok).toBe(1);
    expect(await ledgerFilenames()).toEqual(['PUBLIC_DISPATCHIS_20260101.zip', 'PUBLIC_DISPATCHSCADA_20260101.zip']);
  });
});

describe('runBackfill — rooftop PV feed (LAB-1701)', () => {
  const ROOF_LISTING = 'https://nemweb.com.au/Reports/Archive/ROOFTOP_PV/ACTUAL/';

  function rooftopCsv(date: string, halfHour: number): string {
    const mins = (halfHour + 1) * 30;
    const hh = String(Math.floor(mins / 60)).padStart(2, '0');
    const mm = String(mins % 60).padStart(2, '0');
    const ts = `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6, 8)} ${hh}:${mm}:00`;
    return [
      `C,NEMP.WORLD,ROOFTOP_PV_ACTUAL_MEASUREMENT,AEMO,PUBLIC,${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6, 8)},00:00:00,1,DEMAND,1`,
      'I,ROOFTOP,ACTUAL,2,INTERVAL_DATETIME,REGIONID,POWER,QI,TYPE,LASTCHANGED',
      `D,ROOFTOP,ACTUAL,2,"${ts}",NSW1,300.5,1,MEASUREMENT,"${ts}"`,
      `D,ROOFTOP,ACTUAL,2,"${ts}",VIC1,120.25,0.7,MEASUREMENT,"${ts}"`,
      '',
    ].join('\r\n');
  }

  /** Weekly bundle shape: inner half-hour zips across several days, two levels like the daily feeds. */
  function buildRooftopWeekly(dates: string[], halfHoursPerDay: number): Uint8Array {
    const inner: Record<string, Uint8Array> = {};
    for (const date of dates) {
      for (let i = 0; i < halfHoursPerDay; i++) {
        const mins = (i + 1) * 30;
        const hh = String(Math.floor(mins / 60)).padStart(2, '0');
        const mm = String(mins % 60).padStart(2, '0');
        const name = `PUBLIC_ROOFTOP_PV_ACTUAL_MEASUREMENT_${date}${hh}${mm}00_000000000000${String(i).padStart(4, '0')}`;
        inner[`${name}.zip`] = zipSync({ [`${name}.CSV`]: strToU8(rooftopCsv(date, i)) });
      }
    }
    return zipSync(inner);
  }

  it('ingests a weekly rooftop bundle end to end: D1 rows, R2 raw zip, ledger', async () => {
    const bundle = 'PUBLIC_ROOFTOP_PV_ACTUAL_MEASUREMENT_20260101.zip';
    routes.set(ROOF_LISTING, () => new Response(
      `<html><body><pre><A HREF="/Reports/Archive/ROOFTOP_PV/ACTUAL/${bundle}">${bundle}</A><br>` +
        // SATELLITE weekly bundle on the same listing must be ignored outright.
        '<A HREF="/Reports/Archive/ROOFTOP_PV/ACTUAL/PUBLIC_ROOFTOP_PV_ACTUAL_SATELLITE_20260101.zip">sat</A><br>' +
        '</pre></body></html>',
      { headers: { 'content-type': 'text/html' } },
    ));
    routes.set(`${ROOF_LISTING}${bundle}`, () => new Response(buildRooftopWeekly(['20260101', '20260102'], 3)));

    const run = await runBackfill(env, ROOFTOP_FEED);
    // 2 days × 3 half-hours × 2 regions.
    expect(run).toEqual({ ok: 1, failed: 0, values: 12, remaining: 0 });

    // "2026/01/01 00:30:00" NEM market time (UTC+10), period-ending.
    const expected = Date.UTC(2026, 0, 1, 0, 30, 0) / 1000 - 10 * 3600;
    const nsw = await env.DB.prepare(
      "SELECT power, quality FROM rooftop_pv WHERE interval_time = ? AND region = 'NSW1'",
    )
      .bind(expected)
      .first<{ power: number; quality: number }>();
    expect(nsw).toEqual({ power: 300.5, quality: 1 });

    expect(await env.ARCHIVE.head(`archive/${bundle}`)).not.toBeNull();
    expect(await ledgerFilenames()).toEqual([bundle]);
  });

  it("rooftop's ledger range never masks, or is masked by, the other feeds' bundles", async () => {
    // Same-date bundles from both other feeds land inside the rooftop range
    // scan bounds; the per-feed GLOB keeps all three apart.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO scrape (filename, ingested_at) VALUES ('PUBLIC_DISPATCHSCADA_20260101.zip', 1)"),
      env.DB.prepare("INSERT INTO scrape (filename, ingested_at) VALUES ('PUBLIC_DISPATCHIS_20260101.zip', 1)"),
    ]);
    const bundle = 'PUBLIC_ROOFTOP_PV_ACTUAL_MEASUREMENT_20260101.zip';
    routes.set(ROOF_LISTING, () => new Response(
      `<html><body><pre><A HREF="/Reports/Archive/ROOFTOP_PV/ACTUAL/${bundle}">${bundle}</A><br></pre></body></html>`,
      { headers: { 'content-type': 'text/html' } },
    ));
    routes.set(`${ROOF_LISTING}${bundle}`, () => new Response(buildRooftopWeekly(['20260101'], 2)));

    const run = await runBackfill(env, ROOFTOP_FEED);
    expect(run.ok).toBe(1);
    expect(await ledgerFilenames()).toEqual([
      'PUBLIC_DISPATCHIS_20260101.zip',
      'PUBLIC_DISPATCHSCADA_20260101.zip',
      bundle,
    ]);
  });
});

describe('ingestBundle', () => {
  it('tolerates a corrupt inner file: counts it, ingests the rest, still ledgers the day', async () => {
    const zip = zipSync({
      'PUBLIC_DISPATCHSCADA_202601010005_0000000000000001.zip': zipSync({
        'PUBLIC_DISPATCHSCADA_202601010005_0000000000000001.CSV': strToU8(intervalCsv('20260101', 0, KNOWN_DUIDS)),
      }),
      'PUBLIC_DISPATCHSCADA_202601010010_0000000000000002.zip': strToU8('not a zip at all'),
    });
    await env.ARCHIVE.put('archive/PUBLIC_DISPATCHSCADA_20260101.zip', zip);

    const stats = await ingestBundle(env, SCADA_FEED, await SCADA_FEED.createProcessor(env), 'PUBLIC_DISPATCHSCADA_20260101.zip');
    expect(stats).toMatchObject({ innerFiles: 2, skippedInner: 1, values: 2, intervals: 1, source: 'r2' });
    expect(await valueCount()).toBe(2);
    expect(await ledgerFilenames()).toEqual(['PUBLIC_DISPATCHSCADA_20260101.zip']);
  });

  it('fails the whole day (unledgered, not archived) when no inner file has UNIT_SCADA rows', async () => {
    const emptyCsv = 'C,NEMP.WORLD,DISPATCHSCADA,AEMO,PUBLIC,2026/01/01,00:00:00,1,DISPATCHSCADA,1\r\n';
    const zip = zipSync({
      'PUBLIC_DISPATCHSCADA_202601010005_0000000000000001.zip': zipSync({ 'X.CSV': strToU8(emptyCsv) }),
    });
    interceptDaily('20260101', zip);

    await expect(
      ingestBundle(env, SCADA_FEED, await SCADA_FEED.createProcessor(env), 'PUBLIC_DISPATCHSCADA_20260101.zip'),
    ).rejects.toThrow(/no usable rows/);
    expect(await ledgerFilenames()).toEqual([]);
    expect(await env.ARCHIVE.head('archive/PUBLIC_DISPATCHSCADA_20260101.zip')).toBeNull();
  });
});
