import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CDEII_BASE_URL,
  FACTORS_FILE,
  parseDailyIndex,
  parseEmissionFactors,
  refreshCdeii,
  splitCsvLine,
  SUMMARY_FILE,
} from '../src/cdeii';

// Shaped exactly like the live file (verified 2026-08-08), trimmed to the rows
// that carry a hazard:
//  - a station name containing a comma (Haughton is live today) — the reason
//    this file cannot use the split-on-comma parse src/scada.ts uses;
//  - a DUID repeated across gensets, which is normal and must collapse;
//  - a blank DUID and a non-numeric factor, which must be skipped not thrown.
const FACTORS_CSV = [
  'C,SETP.WORLD,CO2EII_AVAILABLE_GENERATORS_WEB,AEMO,PUBLIC,2026/08/07,09:48:17,0000000531409885,,0000000531409866',
  'I,CO2EII,PUBLISHING,1,STATIONNAME,DUID,GENSETID,REGIONID,CO2E_EMISSIONS_FACTOR,CO2E_ENERGY_SOURCE,CO2E_DATA_SOURCE',
  'D,CO2EII,PUBLISHING,1,"Haughton Solar Farm Stage 1, Units 1-81",HAUGHT11,HAUGHT11,QLD1,0.00000000,Solar,ISP2024',
  'D,CO2EII,PUBLISHING,1,"BAYSWATER POWER STATION",BW01,BW01,NSW1,0.91000000,"Black coal",ISP2024',
  'D,CO2EII,PUBLISHING,1,"MURRAY",MURRAY,MURRAY1,NSW1,0.00000000,Water,ISP2024',
  'D,CO2EII,PUBLISHING,1,"MURRAY",MURRAY,MURRAY2,NSW1,0.00000000,Water,ISP2024',
  'D,CO2EII,PUBLISHING,1,"Broken",,,NSW1,0.5,Wind,ISP2024',
  'D,CO2EII,PUBLISHING,1,"Broken 2",BROKEN2,BROKEN2,NSW1,not-a-number,Wind,ISP2024',
  'C,"END OF REPORT",7',
].join('\n');

const SUMMARY_CSV = [
  'C,SETP.WORLD,CO2EII_RESULTS_SUMMARY,AEMO,PUBLIC,2026/08/07,09:48:17,0000000531409886,,0000000531409866',
  'I,CO2EII,PUBLISHING,1,CONTRACTYEAR,WEEKNO,SETTLEMENTDATE,REGIONID,TOTAL_SENT_OUT_ENERGY,TOTAL_EMISSIONS,CO2E_INTENSITY_INDEX',
  'D,CO2EII,PUBLISHING,1,2026,31,"2026/08/01 00:00:00",NEM,554443.66919841,332955.70186916,0.600500',
  'D,CO2EII,PUBLISHING,1,2026,31,"2026/08/01 00:00:00",NSW1,186556.13997906,118069.38302468,0.632900',
  'D,CO2EII,PUBLISHING,1,2026,31,"2026/08/01 00:00:00",BAD,x,y,z',
  'C,"END OF REPORT",3',
].join('\n');

// 2026/08/01 00:00:00 AEST.
const AUG1_AEST = Date.parse('2026-08-01T00:00:00+10:00') / 1000;

describe('splitCsvLine', () => {
  it('keeps commas inside quoted fields and unescapes doubled quotes', () => {
    expect(splitCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
    expect(splitCsvLine('a,"say ""hi""",d')).toEqual(['a', 'say "hi"', 'd']);
    expect(splitCsvLine('a,,c')).toEqual(['a', '', 'c']);
  });
});

describe('parseEmissionFactors', () => {
  it('does not shift columns on a station name containing a comma', () => {
    const { factors } = parseEmissionFactors(FACTORS_CSV);
    // The naive split-on-comma parse would read GENSETID here and NaN the factor.
    expect(factors.find((f) => f.duid === 'HAUGHT11')).toEqual({ duid: 'HAUGHT11', factor: 0 });
  });

  it('collapses a DUID repeated across gensets and skips malformed rows', () => {
    const { factors, malformed } = parseEmissionFactors(FACTORS_CSV);
    expect(factors.map((f) => f.duid).sort()).toEqual(['BW01', 'HAUGHT11', 'MURRAY']);
    expect(factors.find((f) => f.duid === 'BW01')?.factor).toBe(0.91);
    expect(malformed).toBe(2); // blank DUID, non-numeric factor
  });

  it('drops — never guesses — a DUID listed with two different factors', () => {
    const conflicting = FACTORS_CSV.replace('MURRAY,MURRAY2,NSW1,0.00000000', 'MURRAY,MURRAY2,NSW1,0.70000000');
    const { factors, malformed } = parseEmissionFactors(conflicting);
    // Neither factor is trustworthy, so MURRAY simply has none: the intensity
    // endpoint then excludes it and counts it against `coverage`, which is the
    // same honest treatment any unfactored unit gets. Throwing here would
    // block the official-index write too, every day, until AEMO relented.
    expect(factors.map((f) => f.duid).sort()).toEqual(['BW01', 'HAUGHT11']);
    expect(malformed).toBe(3); // blank DUID, non-numeric factor, conflicted DUID
  });

  it('reads the table whose columns match, and only D rows of that table version', () => {
    // AEMO's normal schema migration publishes both versions side by side. A
    // v2 row parsed with v1 column positions would upsert a silently shifted
    // factor into a public series.
    const twoVersions = FACTORS_CSV.replace(
      'C,"END OF REPORT",7',
      [
        'I,CO2EII,PUBLISHING,2,STATIONNAME,DUID,GENSETID,REGIONID,CO2E_ENERGY_SOURCE,CO2E_EMISSIONS_FACTOR,CO2E_DATA_SOURCE',
        'D,CO2EII,PUBLISHING,2,"Future Station",FUTURE1,FUTURE1,NSW1,Wind,0.12000000,ISP2026',
        'C,"END OF REPORT",9',
      ].join('\n'),
    );
    // Column order differs between the versions, so picking the wrong header
    // would read "Wind" as the factor and NaN it.
    const { factors } = parseEmissionFactors(twoVersions);
    expect(factors.map((f) => f.duid).sort()).toEqual(['BW01', 'HAUGHT11', 'MURRAY']);
  });

  it('rejects an implausible factor rather than publishing it', () => {
    const absurd = FACTORS_CSV.replace('BW01,NSW1,0.91000000', 'BW01,NSW1,910.0');
    expect(parseEmissionFactors(absurd).factors.map((f) => f.duid)).not.toContain('BW01');
  });

  it('is fatal on a renamed column instead of silently reading the wrong one', () => {
    expect(() => parseEmissionFactors(FACTORS_CSV.replace('CO2E_EMISSIONS_FACTOR', 'CO2E_FACTOR'))).toThrow(
      /no I,CO2EII,PUBLISHING table declaring all of DUID, CO2E_EMISSIONS_FACTOR/,
    );
  });
});

describe('parseDailyIndex', () => {
  it('parses AEST settlement dates and skips malformed rows', () => {
    const { rows, malformed } = parseDailyIndex(SUMMARY_CSV);
    expect(malformed).toBe(1);
    expect(rows).toEqual([
      {
        settlementDate: AUG1_AEST,
        region: 'NEM',
        sentOutEnergy: 554443.66919841,
        emissions: 332955.70186916,
        intensity: 0.6005,
      },
      {
        settlementDate: AUG1_AEST,
        region: 'NSW1',
        sentOutEnergy: 186556.13997906,
        emissions: 118069.38302468,
        intensity: 0.6329,
      },
    ]);
  });
});

describe('refreshCdeii', () => {
  const served = new Map<string, { status: number; body: string }>();

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM emission_factors').run();
    await env.DB.prepare('DELETE FROM cdeii_daily').run();
    served.clear();
    served.set(FACTORS_FILE, { status: 200, body: FACTORS_CSV });
    served.set(SUMMARY_FILE, { status: 200, body: SUMMARY_CSV });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const entry = served.get(url.pathname.slice(url.pathname.lastIndexOf('/') + 1));
      if (entry === undefined) return new Response('not found', { status: 404 });
      return new Response(entry.body, { status: entry.status });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Relax the row-count floors so the trimmed fixtures are usable. */
  async function refreshWithoutFloors(): Promise<void> {
    // The floors guard a truncated LIVE file; the fixtures are deliberately
    // tiny, so exercise the write path by padding them to clear the floors.
    const padFactors = Array.from(
      { length: 400 },
      (_, i) => `D,CO2EII,PUBLISHING,1,"Pad ${i}",PAD${i},PAD${i},NSW1,0.10000000,Wind,ISP2024`,
    ).join('\n');
    const padDaily = Array.from(
      { length: 180 },
      (_, i) => `D,CO2EII,PUBLISHING,1,2026,31,"2026/08/01 00:00:00",PAD${i},1,1,0.5`,
    ).join('\n');
    served.set(FACTORS_FILE, { status: 200, body: `${FACTORS_CSV}\n${padFactors}` });
    served.set(SUMMARY_FILE, { status: 200, body: `${SUMMARY_CSV}\n${padDaily}` });
    await refreshCdeii(env, CDEII_BASE_URL);
  }

  it('upserts both files and is idempotent across runs', async () => {
    await refreshWithoutFloors();
    await refreshWithoutFloors();

    const factor = await env.DB.prepare('SELECT factor FROM emission_factors WHERE duid = ?')
      .bind('BW01')
      .first<{ factor: number }>();
    expect(factor).toEqual({ factor: 0.91 });

    const daily = await env.DB.prepare('SELECT intensity FROM cdeii_daily WHERE settlement_date = ? AND region = ?')
      .bind(AUG1_AEST, 'NSW1')
      .first<{ intensity: number }>();
    expect(daily?.intensity).toBe(0.6329);

    const counts = await env.DB.prepare(
      'SELECT (SELECT count(*) FROM emission_factors) AS f, (SELECT count(*) FROM cdeii_daily) AS d',
    ).first<{ f: number; d: number }>();
    expect(counts).toEqual({ f: 403, d: 182 }); // no duplicates on the second run
  });

  it('refuses to write a truncated file, leaving existing rows intact', async () => {
    await refreshWithoutFloors();
    served.set(FACTORS_FILE, { status: 200, body: FACTORS_CSV }); // 3 factors, under the floor
    await expect(refreshCdeii(env, CDEII_BASE_URL)).rejects.toThrow(/refusing to upsert/);

    const n = await env.DB.prepare('SELECT count(*) AS n FROM emission_factors').first<{ n: number }>();
    expect(n?.n).toBe(403);
  });

  it('writes nothing when either file fails to fetch', async () => {
    served.set(SUMMARY_FILE, { status: 503, body: '' });
    await expect(refreshCdeii(env, CDEII_BASE_URL)).rejects.toThrow(/HTTP 503/);

    const n = await env.DB.prepare('SELECT count(*) AS n FROM emission_factors').first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('writes factors and the official index in one transaction', async () => {
    // They are the estimate and the line it is reconciled against: publishing
    // one against a stale copy of the other makes the harness report a drift
    // that is ours, not AEMO's. A malformed daily file must take the factor
    // write down with it.
    await refreshWithoutFloors();
    await env.DB.prepare('DELETE FROM emission_factors').run();
    served.set(SUMMARY_FILE, { status: 200, body: 'C,junk\n' });

    await expect(refreshCdeii(env, CDEII_BASE_URL)).rejects.toThrow();
    const n = await env.DB.prepare('SELECT count(*) AS n FROM emission_factors').first<{ n: number }>();
    expect(n?.n).toBe(0); // factors were NOT written despite parsing fine
  });

  it('refuses an oversized upstream body rather than OOMing the isolate', async () => {
    served.set(FACTORS_FILE, { status: 200, body: 'x'.repeat(9 * 1024 * 1024) });
    await expect(refreshCdeii(env, CDEII_BASE_URL)).rejects.toThrow(/refusing to parse/);
  });
});
