import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ingestEmissions, parseCdeiiCsv, parseFactorsCsv, parseSummaryCsv, splitCsvLine } from '../src/emissions';

// Shapes captured from the live CDEII files, 2026-08-08. The Haughton row is
// the one live station name containing a comma — the reason parsing is a
// quote-aware split, not the UNIT_SCADA split-on-comma shortcut.
const FACTORS_CSV = `C,SETP.WORLD,CO2EII_AVAILABLE_GENERATORS_WEB,AEMO,PUBLIC,2026/08/07,09:48:17,0000000531409885,,0000000531409866
I,CO2EII,PUBLISHING,1,STATIONNAME,DUID,GENSETID,REGIONID,CO2E_EMISSIONS_FACTOR,CO2E_ENERGY_SOURCE,CO2E_DATA_SOURCE
D,CO2EII,PUBLISHING,1,"Appin Power Plant",APPIN,APPIN,NSW1,0.56318004,"Coal seam methane","NGA 2024"
D,CO2EII,PUBLISHING,1,"Haughton Solar Farm Stage 1, Units 1-81",HAUGHT11,HAUGHT11,QLD1,0.00000000,Solar,ISP2024
D,CO2EII,PUBLISHING,1,"Bayswater",BW01,BW01,NSW1,0.87500000,"Black coal","NGA 2024"
D,CO2EII,PUBLISHING,1,"Broken",,BROKEN,NSW1,0.10000000,Gas,ISP2024
D,CO2EII,PUBLISHING,1,"Broken2",BROKEN2,BROKEN2,NSW1,not-a-number,Gas,ISP2024
C,"END OF REPORT",6`;

const SUMMARY_CSV = `C,SETP.WORLD,CO2EII_RESULTS_SUMMARY,AEMO,PUBLIC,2026/08/07,09:48:17,0000000531409886,,0000000531409866
I,CO2EII,PUBLISHING,1,CONTRACTYEAR,WEEKNO,SETTLEMENTDATE,REGIONID,TOTAL_SENT_OUT_ENERGY,TOTAL_EMISSIONS,CO2E_INTENSITY_INDEX
D,CO2EII,PUBLISHING,1,2026,1,"2025/12/28 00:00:00",NEM,409023.86979168,216214.27299651,0.528600
D,CO2EII,PUBLISHING,1,2026,1,"2025/12/28 00:00:00",TAS1,21876.90659142,0.00000000,0.000000
D,CO2EII,PUBLISHING,1,2026,1,"garbage-date",VIC1,1,1,0.5
C,"END OF REPORT",3`;

// 2025-12-28 00:00 AEST = 2025-12-27 14:00 UTC.
const DEC28_AEST = Date.UTC(2025, 11, 27, 14) / 1000;

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM emission_factors'), env.DB.prepare('DELETE FROM cdeii_index')]);
});

describe('splitCsvLine', () => {
  it('keeps commas inside quoted fields and unescapes doubled quotes', () => {
    expect(splitCsvLine('a,"b, c",d')).toEqual(['a', 'b, c', 'd']);
    expect(splitCsvLine('"say ""hi""",2')).toEqual(['say "hi"', '2']);
    expect(splitCsvLine('plain,,end')).toEqual(['plain', '', 'end']);
  });
});

describe('parseCdeiiCsv', () => {
  it('resolves columns by name from the I row, so reordering cannot misparse', () => {
    const reordered = `I,CO2EII,PUBLISHING,1,DUID,STATIONNAME,GENSETID,REGIONID,CO2E_EMISSIONS_FACTOR
D,CO2EII,PUBLISHING,1,APPIN,"Appin Power Plant",APPIN,NSW1,0.56318004`;
    const rows = parseCdeiiCsv(reordered, ['DUID']);
    expect(rows[0].DUID).toBe('APPIN');
    expect(rows[0].STATIONNAME).toBe('Appin Power Plant');
  });

  it('throws on a missing required column (format drift fails loudly)', () => {
    expect(() => parseCdeiiCsv('I,CO2EII,PUBLISHING,1,DUID\nD,CO2EII,PUBLISHING,1,X', ['CO2E_EMISSIONS_FACTOR'])).toThrow(
      /missing expected column/,
    );
  });
});

describe('parseFactorsCsv', () => {
  it('parses factor rows including comma-bearing station names; malformed rows counted, not thrown', () => {
    const { rows, malformed } = parseFactorsCsv(FACTORS_CSV);
    expect(malformed).toBe(2); // empty DUID + non-numeric factor
    expect(rows.map((r) => r.duid)).toEqual(['APPIN', 'HAUGHT11', 'BW01']);
    expect(rows[1].stationName).toBe('Haughton Solar Farm Stage 1, Units 1-81');
    expect(rows[0]).toMatchObject({ factor: 0.56318004, region: 'NSW1', dataSource: 'NGA 2024' });
  });
});

describe('parseSummaryCsv', () => {
  it('parses official index rows with AEST-midnight days as unix seconds', () => {
    const { rows, malformed } = parseSummaryCsv(SUMMARY_CSV);
    expect(malformed).toBe(1); // garbage date
    expect(rows).toEqual([
      { day: DEC28_AEST, region: 'NEM', totalEnergy: 409023.86979168, totalEmissions: 216214.27299651, intensity: 0.5286 },
      { day: DEC28_AEST, region: 'TAS1', totalEnergy: 21876.90659142, totalEmissions: 0, intensity: 0 },
    ]);
  });
});

describe('ingestEmissions', () => {
  it('writes factors and index rows, and a re-ingest REPLACES the factor set', async () => {
    await ingestEmissions(env.DB, FACTORS_CSV, SUMMARY_CSV);
    const factors = await env.DB.prepare('SELECT duid, factor FROM emission_factors ORDER BY duid').all();
    expect(factors.results).toEqual([
      { duid: 'APPIN', factor: 0.56318004 },
      { duid: 'BW01', factor: 0.875 },
      { duid: 'HAUGHT11', factor: 0 },
    ]);
    const index = await env.DB.prepare('SELECT day, region, intensity FROM cdeii_index ORDER BY region').all();
    expect(index.results).toEqual([
      { day: DEC28_AEST, region: 'NEM', intensity: 0.5286 },
      { day: DEC28_AEST, region: 'TAS1', intensity: 0 },
    ]);

    // A generator retired from the upstream file must not linger.
    const next = FACTORS_CSV.split('\n')
      .filter((l) => !l.includes('APPIN'))
      .join('\n');
    await ingestEmissions(env.DB, next, SUMMARY_CSV);
    const after = await env.DB.prepare('SELECT duid FROM emission_factors ORDER BY duid').all();
    expect(after.results).toEqual([{ duid: 'BW01' }, { duid: 'HAUGHT11' }]);
  });

  it('rejects an empty parse and leaves the previous snapshot intact', async () => {
    await ingestEmissions(env.DB, FACTORS_CSV, SUMMARY_CSV);
    const noData = 'I,CO2EII,PUBLISHING,1,STATIONNAME,DUID,GENSETID,REGIONID,CO2E_EMISSIONS_FACTOR';
    await expect(ingestEmissions(env.DB, noData, SUMMARY_CSV)).rejects.toThrow(/no factor rows/);
    const { results } = await env.DB.prepare('SELECT count(*) AS n FROM emission_factors').all<{ n: number }>();
    expect(results[0].n).toBe(3);
  });
});
