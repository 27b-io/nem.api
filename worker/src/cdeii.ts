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
const FACTOR_CHUNK_ROWS = 50; // 2 params each
const DAILY_CHUNK_ROWS = 20; // 5 params each

export interface EmissionFactor {
  duid: string;
  factor: number;
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
 * rows plus a name→index map. Throws when no such header exists — the caller
 * aborts the refresh, leaving existing rows intact.
 *
 * Both CDEII files declare `I,CO2EII,PUBLISHING,<version>` and differ only in
 * their column list, so the table is picked by matching the COLUMNS (not just
 * that prefix), and its data rows are then filtered on the matched header's
 * VERSION as well. AEMO's normal way to change a schema is to publish both
 * versions for a while; taking the first header and every D row would parse
 * the new rows with the old column positions and upsert silently shifted
 * numbers into a public series.
 */
export function parseCdeiiTable(text: string, required: string[]): { rows: string[][]; column: Map<string, number> } {
  const lines = text.split(/\r?\n/);
  let header: string[] | undefined;
  for (const line of lines) {
    if (!line.startsWith(`I,${TABLE_PREFIX}`)) continue;
    const names = splitCsvLine(line);
    if (required.every((name) => names.includes(name))) {
      header = names;
      break;
    }
  }
  if (header === undefined) {
    throw new Error(
      `CDEII file has no I,CO2EII,PUBLISHING table declaring all of ${required.join(', ')} — AEMO renamed a column?`,
    );
  }

  const column = new Map(required.map((name) => [name, header.indexOf(name)]));
  // Field 3 of an MMS I/D row is the table version the row conforms to.
  const dataPrefix = `D,${TABLE_PREFIX}${header[3]},`;
  return { rows: lines.filter((l) => l.startsWith(dataPrefix)).map(splitCsvLine), column };
}

/**
 * CO2EII_AVAILABLE_GENERATORS.CSV → one factor per DUID. The file is
 * per-GENSETID, so multi-genset DUIDs repeat (43 of 573 do today) — always
 * with the same factor.
 *
 * A repeat carrying a DIFFERENT factor means DUID is no longer a safe key for
 * this table, so that DUID is DROPPED, not guessed at with last-write-wins:
 * it then has no factor, which the intensity endpoint already handles honestly
 * by excluding it and counting it against `coverage`. Dropping rather than
 * throwing matters because the same file is re-fetched every day — a throw
 * would block the official-index write too, every day, until AEMO changed the
 * file back.
 */
export function parseEmissionFactors(text: string): { factors: EmissionFactor[]; malformed: number } {
  const { rows, column } = parseCdeiiTable(text, ['DUID', 'CO2E_EMISSIONS_FACTOR']);
  const duidCol = column.get('DUID') as number;
  const factorCol = column.get('CO2E_EMISSIONS_FACTOR') as number;

  const byDuid = new Map<string, EmissionFactor>();
  const conflicted = new Set<string>();
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
      if (existing.factor !== factor) conflicted.add(duid);
      continue;
    }
    byDuid.set(duid, { duid, factor });
  }
  if (conflicted.size > 0) {
    console.warn(
      `cdeii: dropped ${conflicted.size} DUID(s) listed with conflicting factors: ${[...conflicted].sort().join(', ')}`,
    );
    for (const duid of conflicted) byDuid.delete(duid);
  }
  return { factors: [...byDuid.values()], malformed: malformed + conflicted.size };
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

// Both files are well under 200 KB today. The ceiling is not about AEMO
// misbehaving: parsing holds the split lines, the row arrays and the map at
// once (~4x the body), so an unbounded body is an isolate OOM on a scheduled
// handler that has no other failure mode.
const MAX_FILE_BYTES = 8 * 1024 * 1024;

async function fetchText(filename: string, baseUrl: string): Promise<string> {
  const res = await fetch(new URL(filename, baseUrl));
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${filename}`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
    throw new Error(`${filename} is ${declared} bytes (> ${MAX_FILE_BYTES}) — refusing to parse`);
  }
  const text = await res.text();
  if (text.length > MAX_FILE_BYTES) {
    throw new Error(`${filename} decoded to ${text.length} chars (> ${MAX_FILE_BYTES}) — refusing to parse`);
  }
  return text;
}

/** Chunked upsert statements, split to respect D1's 100-bound-param cap. */
function upsertStatements(
  db: D1Database,
  sqlFor: (rowCount: number) => string,
  rows: unknown[][],
  chunkRows: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += chunkRows) {
    const chunk = rows.slice(i, i + chunkRows);
    statements.push(db.prepare(sqlFor(chunk.length)).bind(...chunk.flat()));
  }
  return statements;
}

/**
 * Fetch both CDEII files and upsert them. Both are parsed and sanity-checked
 * before anything is written, and both writes go in ONE d1 batch (= one
 * transaction) — so factors and the official index they are reconciled against
 * can never end up describing different publications of the file. Two batches
 * would leave exactly that state behind on a mid-write failure, and the
 * reconciliation harness would then report a drift that is ours, not AEMO's.
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

  await env.DB.batch([
    ...upsertStatements(
      env.DB,
      (n) =>
        'INSERT INTO emission_factors (duid, factor) VALUES ' +
        Array.from({ length: n }, () => '(?,?)').join(',') +
        ' ON CONFLICT(duid) DO UPDATE SET factor = excluded.factor',
      factors.map((f) => [f.duid, f.factor]),
      FACTOR_CHUNK_ROWS,
    ),
    ...upsertStatements(
      env.DB,
      (n) =>
        'INSERT INTO cdeii_daily (settlement_date, region, sent_out_energy, emissions, intensity) VALUES ' +
        Array.from({ length: n }, () => '(?,?,?,?,?)').join(',') +
        ' ON CONFLICT(settlement_date, region) DO UPDATE SET ' +
        'sent_out_energy = excluded.sent_out_energy, emissions = excluded.emissions, intensity = excluded.intensity',
      daily.map((r) => [r.settlementDate, r.region, r.sentOutEnergy, r.emissions, r.intensity]),
      DAILY_CHUNK_ROWS,
    ),
  ]);

  console.log(`cdeii: refreshed ${factors.length} emission factor(s), ${daily.length} official daily index row(s)`);
}
