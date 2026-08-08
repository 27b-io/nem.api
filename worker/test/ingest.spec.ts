import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { DISPATCH_IS_FEED, extractZipFilenames, loadDuidMap, upsertDispatchRows, upsertValues } from '../src/ingest';

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
