import { env } from 'cloudflare:test';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DISPATCH_IS_FEED,
  extractZipFilenames,
  fetchNemweb,
  loadDuidMap,
  ROOFTOP_FEED,
  runIngest,
  upsertDispatchRows,
  upsertRooftopRows,
  upsertValues,
} from '../src/ingest';

describe('upsertValues', () => {
  it('is idempotent: inserting the same key twice leaves one row, last value wins', async () => {
    const row = { scrapeTime: 1784900100, generatorId: 42, value: 123.45 };
    await upsertValues(env.DB, [row]);
    await upsertValues(env.DB, [{ ...row, value: 200.5 }]);

    const result = await env.DB.prepare(
      'SELECT count(*) AS n, max(value) AS value FROM scada_values WHERE scrape_time = ? AND generator_id = ?',
    )
      .bind(row.scrapeTime, row.generatorId)
      .first<{ n: number; value: number }>();
    expect(result).toEqual({ n: 1, value: 200.5 });
  });

  it('chunks large batches across the D1 bound-parameter limit', async () => {
    // 70 rows spans three 32-row chunks.
    const rows = Array.from({ length: 70 }, (_, i) => ({
      scrapeTime: 1784900100,
      generatorId: i + 1,
      value: i,
    }));
    await upsertValues(env.DB, rows);
    const result = await env.DB.prepare('SELECT count(*) AS n FROM scada_values').first<{ n: number }>();
    expect(result?.n).toBe(70);
  });
});

describe('upsertDispatchRows', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM dispatch_region'),
      env.DB.prepare('DELETE FROM dispatch_interconnector'),
    ]);
  });

  async function regionRow(time: number, region: string) {
    return env.DB.prepare('SELECT rrp, total_demand FROM dispatch_region WHERE settlement_time = ? AND region = ?')
      .bind(time, region)
      .first<{ rrp: number | null; total_demand: number | null }>();
  }

  it('is idempotent and COALESCEs per column: a partial row never nulls out the other column', async () => {
    // First pass carries price only (as if REGIONSUM were absent from a file).
    await upsertDispatchRows(env.DB, {
      regions: [{ settlementTime: 1784900100, region: 'NSW1', rrp: 110.01, totalDemand: null }],
      interconnectors: [],
    });
    expect(await regionRow(1784900100, 'NSW1')).toEqual({ rrp: 110.01, total_demand: null });

    // Second pass carries demand only — must merge, not overwrite rrp with null.
    await upsertDispatchRows(env.DB, {
      regions: [{ settlementTime: 1784900100, region: 'NSW1', rrp: null, totalDemand: 9655.98 }],
      interconnectors: [],
    });
    expect(await regionRow(1784900100, 'NSW1')).toEqual({ rrp: 110.01, total_demand: 9655.98 });

    // Full re-ingest: last non-null values win, still one row.
    await upsertDispatchRows(env.DB, {
      regions: [{ settlementTime: 1784900100, region: 'NSW1', rrp: 120, totalDemand: 9700 }],
      interconnectors: [{ settlementTime: 1784900100, interconnector: 'V-SA', meteredMwFlow: -79.3 }],
    });
    await upsertDispatchRows(env.DB, {
      regions: [],
      interconnectors: [{ settlementTime: 1784900100, interconnector: 'V-SA', meteredMwFlow: -80.1 }],
    });
    expect(await regionRow(1784900100, 'NSW1')).toEqual({ rrp: 120, total_demand: 9700 });
    const counts = await env.DB.prepare(
      'SELECT (SELECT count(*) FROM dispatch_region) AS r, (SELECT count(*) FROM dispatch_interconnector) AS i, ' +
        "(SELECT metered_mw_flow FROM dispatch_interconnector WHERE interconnector = 'V-SA') AS flow",
    ).first<{ r: number; i: number; flow: number }>();
    expect(counts).toEqual({ r: 1, i: 1, flow: -80.1 });
  });

  it('chunks large batches across the D1 bound-parameter limit', async () => {
    // 60 region rows spans three 25-row chunks; 70 interconnector rows three 32-row chunks.
    await upsertDispatchRows(env.DB, {
      regions: Array.from({ length: 60 }, (_, i) => ({
        settlementTime: 1784900100 + i * 300,
        region: 'NSW1',
        rrp: i,
        totalDemand: i * 10,
      })),
      interconnectors: Array.from({ length: 70 }, (_, i) => ({
        settlementTime: 1784900100 + i * 300,
        interconnector: 'V-SA',
        meteredMwFlow: i,
      })),
    });
    const counts = await env.DB.prepare(
      'SELECT (SELECT count(*) FROM dispatch_region) AS r, (SELECT count(*) FROM dispatch_interconnector) AS i',
    ).first<{ r: number; i: number }>();
    expect(counts).toEqual({ r: 60, i: 70 });
  });
});

describe('DISPATCH_IS_FEED processor', () => {
  it('parse throws on a CSV with no ingestable rows (format drift stays loud)', async () => {
    const processor = await DISPATCH_IS_FEED.createProcessor(env);
    expect(() => processor.parse('C,NEMP.WORLD,DISPATCHIS,AEMO\r\n', 'test')).toThrow(/no DISPATCH/);
  });

  it('parse + store round-trips through D1', async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM dispatch_region'),
      env.DB.prepare('DELETE FROM dispatch_interconnector'),
    ]);
    const processor = await DISPATCH_IS_FEED.createProcessor(env);
    const csv =
      'I,DISPATCH,PRICE,5,SETTLEMENTDATE,RUNNO,REGIONID,DISPATCHINTERVAL,INTERVENTION,RRP\r\n' +
      'D,DISPATCH,PRICE,5,"2026/08/08 20:25:00",1,NSW1,20260808197,0,110.01\r\n' +
      'I,DISPATCH,INTERCONNECTORRES,3,SETTLEMENTDATE,RUNNO,INTERCONNECTORID,DISPATCHINTERVAL,INTERVENTION,METEREDMWFLOW\r\n' +
      'D,DISPATCH,INTERCONNECTORRES,3,"2026/08/08 20:25:00",1,V-SA,20260808197,0,-79.3\r\n';
    const { batch, rows, intervals } = processor.parse(csv, 'test');
    expect(rows).toBe(2);
    expect(intervals.size).toBe(1);
    expect(await processor.store([batch])).toBe(2);
    const counts = await env.DB.prepare(
      'SELECT (SELECT count(*) FROM dispatch_region) AS r, (SELECT count(*) FROM dispatch_interconnector) AS i',
    ).first<{ r: number; i: number }>();
    expect(counts).toEqual({ r: 1, i: 1 });
  });
});

describe('upsertRooftopRows', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM rooftop_pv').run();
  });

  it('is idempotent: re-ingesting an interval overwrites power and quality, one row survives', async () => {
    const row = { intervalTime: 1784901600, region: 'NSW1', power: 4188.5, quality: 1 };
    await upsertRooftopRows(env.DB, [row]);
    await upsertRooftopRows(env.DB, [{ ...row, power: 4200.1, quality: 0.7 }]);

    const result = await env.DB.prepare(
      'SELECT count(*) AS n, max(power) AS power, max(quality) AS quality FROM rooftop_pv WHERE interval_time = ?',
    )
      .bind(row.intervalTime)
      .first<{ n: number; power: number; quality: number }>();
    expect(result).toEqual({ n: 1, power: 4200.1, quality: 0.7 });
  });

  it('chunks large batches across the D1 bound-parameter limit and keeps null quality', async () => {
    // 60 rows spans three 25-row chunks.
    const rows = Array.from({ length: 60 }, (_, i) => ({
      intervalTime: 1784901600 + i * 1800,
      region: 'VIC1',
      power: i,
      quality: i === 0 ? null : 1,
    }));
    await upsertRooftopRows(env.DB, rows);
    const result = await env.DB.prepare(
      'SELECT count(*) AS n, sum(CASE WHEN quality IS NULL THEN 1 ELSE 0 END) AS nulls FROM rooftop_pv',
    ).first<{ n: number; nulls: number }>();
    expect(result).toEqual({ n: 60, nulls: 1 });
  });
});

describe('ROOFTOP_FEED processor', () => {
  it('parse throws on a CSV with no MEASUREMENT rows (format drift stays loud)', async () => {
    const processor = await ROOFTOP_FEED.createProcessor(env);
    expect(() => processor.parse('C,NEMP.WORLD,ROOFTOP_PV_ACTUAL_MEASUREMENT,AEMO\r\n', 'test')).toThrow(
      /no MEASUREMENT/,
    );
  });

  it('parse + store round-trips through D1', async () => {
    await env.DB.prepare('DELETE FROM rooftop_pv').run();
    const processor = await ROOFTOP_FEED.createProcessor(env);
    const csv =
      'I,ROOFTOP,ACTUAL,2,INTERVAL_DATETIME,REGIONID,POWER,QI,TYPE,LASTCHANGED\r\n' +
      'D,ROOFTOP,ACTUAL,2,"2026/08/09 07:30:00",NSW1,302.483,1,MEASUREMENT,"2026/08/09 07:49:02"\r\n' +
      'D,ROOFTOP,ACTUAL,2,"2026/08/09 07:30:00",VIC1,0.953,1,MEASUREMENT,"2026/08/09 07:49:03"\r\n';
    const { batch, rows, intervals } = processor.parse(csv, 'test');
    expect(rows).toBe(2);
    expect(intervals.size).toBe(1);
    expect(await processor.store([batch])).toBe(2);
    const count = await env.DB.prepare('SELECT count(*) AS n FROM rooftop_pv').first<{ n: number }>();
    expect(count?.n).toBe(2);
  });
});

describe('runIngest — ROOFTOP_FEED CURRENT filter', () => {
  let routes: Map<string, () => Response>;
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare('DELETE FROM rooftop_pv'), env.DB.prepare('DELETE FROM scrape')]);
    const archived = await env.ARCHIVE.list({ prefix: 'current/' });
    await Promise.all(archived.objects.map((o) => env.ARCHIVE.delete(o.key)));
    routes = new Map();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      const handler = routes.get(url);
      // Unrouted URLs throw — the SATELLITE assertion below is a real proof
      // that the file was never fetched, not absence of evidence.
      if (!handler) throw new Error(`unexpected fetch: ${url}`);
      return handler();
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('ingests MEASUREMENT files and never touches the SATELLITE variants sharing the folder', async () => {
    const listingUrl = ROOFTOP_FEED.currentListingUrl;
    const measurement = 'PUBLIC_ROOFTOP_PV_ACTUAL_MEASUREMENT_20260809080000_0000000531718665.zip';
    const satellite = 'PUBLIC_ROOFTOP_PV_ACTUAL_SATELLITE_20260809080000_0000000531718667.zip';
    routes.set(
      listingUrl,
      () =>
        new Response(
          `<pre><A HREF="/Reports/Current/ROOFTOP_PV/ACTUAL/${measurement}">${measurement}</A><br>` +
            `<A HREF="/Reports/Current/ROOFTOP_PV/ACTUAL/${satellite}">${satellite}</A><br></pre>`,
          { headers: { 'content-type': 'text/html' } },
        ),
    );
    const csv =
      'I,ROOFTOP,ACTUAL,2,INTERVAL_DATETIME,REGIONID,POWER,QI,TYPE,LASTCHANGED\r\n' +
      'D,ROOFTOP,ACTUAL,2,"2026/08/09 07:30:00",NSW1,302.483,1,MEASUREMENT,"2026/08/09 07:49:02"\r\n';
    routes.set(`${listingUrl}${measurement}`, () => new Response(zipSync({ 'roof.CSV': strToU8(csv) })));
    // No route for the SATELLITE zip: fetching it would throw and fail the run.

    await runIngest(env, ROOFTOP_FEED);

    const count = await env.DB.prepare('SELECT count(*) AS n FROM rooftop_pv').first<{ n: number }>();
    expect(count?.n).toBe(1);
    const ledger = (
      await env.DB.prepare('SELECT filename FROM scrape ORDER BY filename').all<{ filename: string }>()
    ).results.map((r) => r.filename);
    expect(ledger).toEqual([measurement]); // SATELLITE never fetched, never ledgered
    expect(await env.ARCHIVE.head(`current/${measurement}`)).not.toBeNull();
  });
});

describe('loadDuidMap', () => {
  it('maps seeded DUIDs, resolving shared DUIDs to the lowest generator id', async () => {
    const map = await loadDuidMap(env.DB);
    expect(map.size).toBeGreaterThan(300);

    // MURRAY is shared by Murray 1 / Murray 2 — must map to the lower id.
    const murrayIds = (
      await env.DB.prepare("SELECT id FROM generators WHERE duid = 'MURRAY' ORDER BY id").all<{ id: number }>()
    ).results.map((r) => r.id);
    expect(murrayIds).toHaveLength(2);
    expect(map.get('MURRAY')).toBe(murrayIds[0]);

    // Non-market units ('-') never appear in SCADA and must not be mapped.
    expect(map.has('-')).toBe(false);
    expect(map.has('NOT_A_REAL_DUID')).toBe(false);
  });
});

describe('fetchNemweb', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps transport errors to an Error naming the URL, preserving the original as cause', async () => {
    // AbortSignal.timeout rejects with this bare DOMException — no URL, no
    // deadline — which is exactly why fetchNemweb wraps it.
    const abort = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    vi.stubGlobal('fetch', () => Promise.reject(abort));
    const url = 'https://nemweb.com.au/Reports/Current/Dispatch_SCADA/x.zip';
    const err: unknown = await fetchNemweb(url).then(
      () => { throw new Error('expected rejection'); },
      (e: unknown) => e,
    );
    // instanceof narrows with a runtime check — the mapping contract IS that
    // the rejection is an Error, so failing here is the test doing its job.
    if (!(err instanceof Error)) throw new Error(`expected an Error rejection, got ${String(err)}`);
    expect(err.message).toBe(`NEMWEB fetch failed (${url}): The operation was aborted due to timeout`);
    expect(err.cause).toBe(abort);
  });
});

describe('extractZipFilenames', () => {
  it('extracts zip basenames from an IIS-style autoindex (uppercase HREF), sorted and deduped', async () => {
    // Shape captured from the live nemweb.com.au autoindex on 2026-07-23.
    const html = `<html><body><H1>nemweb.com.au - /Reports/CURRENT/Dispatch_SCADA/</H1><hr>
<pre><A HREF="/Reports/CURRENT">[To Parent Directory]</A><br>
<A HREF="/Reports/CURRENT/Dispatch_SCADA/DUPLICATE">DUPLICATE</A><br>
<A HREF="/Reports/CURRENT/Dispatch_SCADA/PUBLIC_DISPATCHSCADA_202607232335_0000000528917241.zip">PUBLIC_DISPATCHSCADA_202607232335_0000000528917241.zip</A><br>
<A HREF="/Reports/CURRENT/Dispatch_SCADA/PUBLIC_DISPATCHSCADA_202607232330_0000000528916800.zip">PUBLIC_DISPATCHSCADA_202607232330_0000000528916800.zip</A><br>
<A HREF="/Reports/CURRENT/Dispatch_SCADA/PUBLIC_DISPATCHSCADA_202607232330_0000000528916800.zip">dupe</A><br>
</pre></body></html>`;
    const names = await extractZipFilenames(new Response(html, { headers: { 'content-type': 'text/html' } }));
    expect(names).toEqual([
      'PUBLIC_DISPATCHSCADA_202607232330_0000000528916800.zip',
      'PUBLIC_DISPATCHSCADA_202607232335_0000000528917241.zip',
    ]);
  });
});
