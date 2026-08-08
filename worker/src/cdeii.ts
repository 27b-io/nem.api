// AEMO CDEII ingest (LAB-1698): the two published inputs behind
// /api/v2/intensity — per-DUID emission factors, and AEMO's own official
// daily intensity index (NER 3.13.14) that we reconcile against.
//
// Both live at https://nemweb.com.au/Reports/Current/CDEII/ as plain CSV (no
// zip container, unlike Dispatch SCADA) and republish weekly, so a daily cron
// is generous. Refresh is pure upsert: a fetch failure, a renamed column or a
// truncated file aborts before any write, and nothing here ever deletes — the
// worst case is that the existing reference data simply stays put.
//
// Why not the split-on-comma parse that src/scada.ts uses: CDEII station
// names contain commas ("Haughton Solar Farm Stage 1, Units 1-81" is live
// today), so every column after the name would shift. UNIT_SCADA's quoted
// fields are timestamps and genuinely cannot contain one, which is why that
// parser is still correct for its own file and is left alone.

import type { Env } from './index';
import { parseSettlementDate } from './scada';

// Daily refresh schedule. Must stay byte-identical to the matching entry in
// wrangler.toml (src/index.ts dispatches on the exact string); offset so it
// lands on neither a */5 ingest minute nor a backfill minute. 20:37 UTC =
// 06:37 AEST, off-peak both sides.
export const CDEII_CRON = '37 20 * * *';

export const CDEII_BASE_URL = 'https://nemweb.com.au/Reports/Current/CDEII/';
export const FACTORS_FILE = 'CO2EII_AVAILABLE_GENERATORS.CSV';
export const SUMMARY_FILE = 'CO2EII_SUMMARY_RESULTS.CSV';

// Both CDEII tables share the same MMS identifier (I,CO2EII,PUBLISHING,1),
// so a file is identified by the columns its I row declares, not by that
// prefix — which also turns any column rename into a loud failure.
const TABLE_PREFIX = 'CO2EII,PUBLISHING,';

// The live factor file lists 573 distinct DUIDs. Far fewer means a truncated
// or mangled fetch; refuse it rather than upsert a partial view that would
// silently drop generation out of the coverage denominator.
const MIN_FACTORS = 400;
// The live summary file carries ~6 months of daily rows, 6 per day.
const MIN_DAILY_ROWS = 180;

// Highest published factor is brown coal at ~1.33 tCO2-e/MWh. Anything beyond
// this band is a parse that landed on the wrong column, not a dirty unit — and
// this number reaches a public page, so it is validated at the boundary.
const MAX_PLAUSIBLE_FACTOR = 5;

// D1 caps a statement at 100 bound parameters.
const FACTOR_CHUNK_ROWS = 33; // 3 params each
const DAILY_CHUNK_ROWS = 20; // 5 params each

export interface EmissionFactor {
  duid: string;
  factor: number;
  dataSource: string;
}

export interface DailyIndexRow {
  settlementDate: number;
  region: string;
  sentOutEnergy: number;
  emissions: number;
  intensity: number;
}

/**
 * Split one CSV line, honouring double-quoted fields (and the doubled-quote
 * escape). AEMO emits RFC-4180-shaped rows; this is the whole grammar they
 * use.
 */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (line[i + 1] === '"') (field += '"'), i++;
      else quoted = false;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

/**
 * Locate the CDEII table declaring every required column and return its data
 * rows plus a name→index map. Throws when the header is missing or a column
 * was renamed — the caller aborts the refresh, leaving existing rows intact.
 */
export function parseCdeiiTable(text: string, required: string[]): { rows: string[][]; column: Map<string, number> } {
  const lines = text.split(/\r?\n/);
  const header = lines.find((l) => l.startsWith(`I,${TABLE_PREFIX}`));
  if (header === undefined) throw new Error('CDEII file has no I,CO2EII,PUBLISHING header row');

  const names = splitCsvLine(header);
  const column = new Map<string, number>();
  for (const name of required) {
    const index = names.indexOf(name);
    if (index < 0) throw new Error(`CDEII file is missing required column "${name}" — AEMO renamed it?`);
    column.set(name, index);
  }

  return { rows: lines.filter((l) => l.startsWith(`D,${TABLE_PREFIX}`)).map(splitCsvLine), column };
}

/**
 * CO2EII_AVAILABLE_GENERATORS.CSV → one factor per DUID. The file is
 * per-GENSETID, so multi-genset DUIDs repeat; a repeat carrying a DIFFERENT
 * factor means DUID is no longer a safe key for this table, which is fatal
 * rather than last-write-wins.
 */
export function parseEmissionFactors(text: string): { factors: EmissionFactor[]; malformed: number } {
  const { rows, column } = parseCdeiiTable(text, ['DUID', 'CO2E_EMISSIONS_FACTOR', 'CO2E_DATA_SOURCE']);
  const duidCol = column.get('DUID') as number;
  const factorCol = column.get('CO2E_EMISSIONS_FACTOR') as number;
  const sourceCol = column.get('CO2E_DATA_SOURCE') as number;

  const byDuid = new Map<string, EmissionFactor>();
  let malformed = 0;
  for (const row of rows) {
    const duid = (row[duidCol] ?? '').trim();
    const factor = Number((row[factorCol] ?? '').trim());
    if (duid === '' || !Number.isFinite(factor) || factor < 0 || factor > MAX_PLAUSIBLE_FACTOR) {
      malformed++;
      continue;
    }
    const existing = byDuid.get(duid);
    if (existing !== undefined) {
      if (existing.factor !== factor) {
        throw new Error(
          `CDEII factor file lists DUID ${duid} with two different factors ` +
            `(${existing.factor}, ${factor}) — DUID is no longer a safe key for this table`,
        );
      }
      continue;
    }
    byDuid.set(duid, { duid, factor, dataSource: (row[sourceCol] ?? '').trim() });
  }
  return { factors: [...byDuid.values()], malformed };
}

/** CO2EII_SUMMARY_RESULTS.CSV → AEMO's official daily index rows. */
export function parseDailyIndex(text: string): { rows: DailyIndexRow[]; malformed: number } {
  const { rows, column } = parseCdeiiTable(text, [
    'SETTLEMENTDATE',
    'REGIONID',
    'TOTAL_SENT_OUT_ENERGY',
    'TOTAL_EMISSIONS',
    'CO2E_INTENSITY_INDEX',
  ]);
  const at = (row: string[], name: string) => (row[column.get(name) as number] ?? '').trim();

  const parsed: DailyIndexRow[] = [];
  let malformed = 0;
  for (const row of rows) {
    const settlementDate = parseSettlementDate(at(row, 'SETTLEMENTDATE'));
    const region = at(row, 'REGIONID');
    const sentOutEnergy = Number(at(row, 'TOTAL_SENT_OUT_ENERGY'));
    const emissions = Number(at(row, 'TOTAL_EMISSIONS'));
    const intensity = Number(at(row, 'CO2E_INTENSITY_INDEX'));
    if (
      settlementDate === null ||
      region === '' ||
      !Number.isFinite(sentOutEnergy) ||
      !Number.isFinite(emissions) ||
      !Number.isFinite(intensity) ||
      intensity < 0 ||
      intensity > MAX_PLAUSIBLE_FACTOR
    ) {
      malformed++;
      continue;
    }
    parsed.push({ settlementDate, region, sentOutEnergy, emissions, intensity });
  }
  return { rows: parsed, malformed };
}

async function fetchText(filename: string, baseUrl: string): Promise<string> {
  const res = await fetch(new URL(filename, baseUrl));
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${filename}`);
  return res.text();
}

/** Chunked upsert in one D1 batch (= one transaction), like src/ingest.ts. */
async function upsertChunked(
  db: D1Database,
  sqlFor: (rowCount: number) => string,
  rows: unknown[][],
  chunkRows: number,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += chunkRows) {
    const chunk = rows.slice(i, i + chunkRows);
    statements.push(db.prepare(sqlFor(chunk.length)).bind(...chunk.flat()));
  }
  await db.batch(statements);
}

/**
 * Fetch both CDEII files and upsert them. Both files are parsed and
 * sanity-checked BEFORE either write, so a half-published pair cannot leave
 * factors and the official index disagreeing about what AEMO currently says.
 */
export async function refreshCdeii(env: Env, baseUrl: string = CDEII_BASE_URL): Promise<void> {
  const [factorsText, summaryText] = await Promise.all([
    fetchText(FACTORS_FILE, baseUrl),
    fetchText(SUMMARY_FILE, baseUrl),
  ]);

  const { factors, malformed: badFactors } = parseEmissionFactors(factorsText);
  const { rows: daily, malformed: badDaily } = parseDailyIndex(summaryText);
  if (factors.length < MIN_FACTORS) {
    throw new Error(`only ${factors.length} emission factors parsed (< ${MIN_FACTORS}) — refusing to upsert`);
  }
  if (daily.length < MIN_DAILY_ROWS) {
    throw new Error(`only ${daily.length} daily index rows parsed (< ${MIN_DAILY_ROWS}) — refusing to upsert`);
  }
  if (badFactors > 0 || badDaily > 0) {
    console.warn(`cdeii: skipped ${badFactors} malformed factor row(s), ${badDaily} malformed daily row(s)`);
  }

  await upsertChunked(
    env.DB,
    (n) =>
      'INSERT INTO emission_factors (duid, factor, data_source) VALUES ' +
      Array.from({ length: n }, () => '(?,?,?)').join(',') +
      ' ON CONFLICT(duid) DO UPDATE SET factor = excluded.factor, data_source = excluded.data_source',
    factors.map((f) => [f.duid, f.factor, f.dataSource]),
    FACTOR_CHUNK_ROWS,
  );

  await upsertChunked(
    env.DB,
    (n) =>
      'INSERT INTO cdeii_daily (settlement_date, region, sent_out_energy, emissions, intensity) VALUES ' +
      Array.from({ length: n }, () => '(?,?,?,?,?)').join(',') +
      ' ON CONFLICT(settlement_date, region) DO UPDATE SET ' +
      'sent_out_energy = excluded.sent_out_energy, emissions = excluded.emissions, intensity = excluded.intensity',
    daily.map((r) => [r.settlementDate, r.region, r.sentOutEnergy, r.emissions, r.intensity]),
    DAILY_CHUNK_ROWS,
  );

  console.log(`cdeii: refreshed ${factors.length} emission factor(s), ${daily.length} official daily index row(s)`);
}
