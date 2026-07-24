import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { extractZipFilenames, loadDuidMap, upsertValues } from '../src/ingest';

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
