import { env } from 'cloudflare:test';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ingestDaily, runBackfill } from '../src/backfill';
import { loadDuidMap } from '../src/ingest';

// Tests run in the same isolate as the code under test, so stubbing global
// fetch covers the module's outbound HTTP (bindings like D1/R2 don't route
// through fetch). Any URL without a registered route throws — "did not
// re-download" assertions below are real proofs, not absence of evidence.
let routes: Map<string, () => Response>;
beforeEach(async () => {
  // vitest-pool-workers gives each test FILE its own runtime + storage, but
  // tests within a file share state — reset what these tests mutate.
  await env.DB.batch([env.DB.prepare('DELETE FROM scada_values'), env.DB.prepare('DELETE FROM scrape')]);
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

    const run = await runBackfill(env);
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
  });

  it('is resumable: ledgered days are skipped without any zip fetch', async () => {
    await env.DB.prepare("INSERT INTO scrape (filename, ingested_at) VALUES ('PUBLIC_DISPATCHSCADA_20260101.zip', 1)")
      .run();
    interceptListing(['20260101', '20260102']);
    interceptDaily('20260102', buildDailyZip('20260102', 2)); // no interceptor for 20260101 — a fetch would fail

    const run = await runBackfill(env);
    expect(run).toEqual({ ok: 1, failed: 0, values: 4, remaining: 0 });

    // Fully idle second pass: nothing fetched beyond the listing, nothing failed.
    interceptListing(['20260101', '20260102']);
    expect(await runBackfill(env)).toEqual({ ok: 0, failed: 0, values: 0, remaining: 0 });
  });

  it('five-minute CURRENT ledger entries do not mask a daily archive', async () => {
    // The same date's CURRENT files interleave lexicographically with the
    // daily name; the ledger diff must only match daily-shaped filenames.
    await env.DB.prepare(
      "INSERT INTO scrape (filename, ingested_at) VALUES ('PUBLIC_DISPATCHSCADA_202601010005_0000000000000001.zip', 1)",
    ).run();
    interceptListing(['20260101']);
    interceptDaily('20260101', buildDailyZip('20260101', 2));

    const run = await runBackfill(env);
    expect(run.ok).toBe(1);
    expect(await ledgerFilenames()).toContain('PUBLIC_DISPATCHSCADA_20260101.zip');
  });

  it('reads a previously archived day from R2 instead of re-downloading', async () => {
    await env.ARCHIVE.put('archive/PUBLIC_DISPATCHSCADA_20260101.zip', buildDailyZip('20260101', 2));
    interceptListing(['20260101']); // no zip interceptor — NEMWEB fetch would throw

    const run = await runBackfill(env);
    expect(run).toEqual({ ok: 1, failed: 0, values: 4, remaining: 0 });
    expect(await ledgerFilenames()).toEqual(['PUBLIC_DISPATCHSCADA_20260101.zip']);
  });
});

describe('ingestDaily', () => {
  it('tolerates a corrupt inner file: counts it, ingests the rest, still ledgers the day', async () => {
    const zip = zipSync({
      'PUBLIC_DISPATCHSCADA_202601010005_0000000000000001.zip': zipSync({
        'PUBLIC_DISPATCHSCADA_202601010005_0000000000000001.CSV': strToU8(intervalCsv('20260101', 0, KNOWN_DUIDS)),
      }),
      'PUBLIC_DISPATCHSCADA_202601010010_0000000000000002.zip': strToU8('not a zip at all'),
    });
    await env.ARCHIVE.put('archive/PUBLIC_DISPATCHSCADA_20260101.zip', zip);

    const stats = await ingestDaily(env, 'PUBLIC_DISPATCHSCADA_20260101.zip', await loadDuidMap(env.DB));
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

    await expect(ingestDaily(env, 'PUBLIC_DISPATCHSCADA_20260101.zip', await loadDuidMap(env.DB))).rejects.toThrow(
      /no UNIT_SCADA rows/,
    );
    expect(await ledgerFilenames()).toEqual([]);
    expect(await env.ARCHIVE.head('archive/PUBLIC_DISPATCHSCADA_20260101.zip')).toBeNull();
  });
});
