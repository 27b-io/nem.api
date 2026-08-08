// CDEII emissions ingest (LAB-1698): fetch AEMO's published per-generator
// CO2-e emission factors and the official daily intensity index from
// nemweb.com.au/Reports/Current/CDEII/ into D1 (migration 0005). Both files
// are small (~630 factor rows, ~6 index rows/day) and re-published weekly;
// the cron runs daily so a missed run self-heals within a day.
//
// Same AEMO multi-table CSV convention as Dispatch SCADA (C comments, I
// column headers, D data), but unlike UNIT_SCADA these files carry quoted
// fields that can contain commas (station names — live example: "Haughton
// Solar Farm Stage 1, Units 1-81"), so parsing is a real quote-aware split,
// and columns are resolved by NAME from the I row rather than by position.
//
// Refresh model: parse-then-replace. Both files parse fully in memory first;
// any drift (missing header column, zero data rows) throws BEFORE the write,
// leaving the previous snapshot intact. The write itself is one D1 batch
// (= one transaction): factors are DELETE + INSERT (removed generators must
// not linger), index rows upsert (they accumulate across contract years).

import type { Env } from './index';
import { parseSettlementDate } from './scada';

export const CDEII_BASE_URL = 'https://nemweb.com.au/Reports/Current/CDEII/';
const FACTORS_FILE = 'CO2EII_AVAILABLE_GENERATORS.CSV';
const SUMMARY_FILE = 'CO2EII_SUMMARY_RESULTS.CSV';

// Must match a cron expression in wrangler.toml exactly — the scheduled
// handler dispatches on controller.cron string equality.
export const EMISSIONS_CRON = '38 19 * * *';

// D1 allows 100 bound parameters per statement.
const FACTOR_COLS = 7;
const INDEX_COLS = 5;

export interface EmissionFactorRow {
  duid: string;
  gensetId: string;
  stationName: string;
  region: string;
  factor: number;
  energySource: string;
  dataSource: string;
}

export interface CdeiiIndexRow {
  /** Unix seconds of the AEST midnight STARTING the day (as published). */
  day: number;
  region: string;
  totalEnergy: number | null;
  totalEmissions: number | null;
  intensity: number;
}

/** RFC-4180-style field split: quoted fields may contain commas and doubled quotes. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Data rows of an AEMO CO2EII CSV as name-addressable records. Columns come
 * from the I header row, so upstream column reordering cannot silently
 * misparse; a missing `required` column throws (format drift must fail the
 * refresh loudly, before any write).
 */
export function parseCdeiiCsv(text: string, required: string[]): Array<Record<string, string>> {
  let header: string[] | null = null;
  const rows: Array<Record<string, string>> = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('I,CO2EII,')) {
      header = splitCsvLine(line);
    } else if (line.startsWith('D,CO2EII,')) {
      if (header === null) throw new Error('CDEII CSV: D row before any I header row');
      const fields = splitCsvLine(line);
      const record: Record<string, string> = {};
      for (let i = 0; i < header.length; i++) record[header[i]] = fields[i] ?? '';
      rows.push(record);
    }
  }
  if (header === null) throw new Error('CDEII CSV: no I header row found');
  for (const name of required) {
    if (!header.includes(name)) throw new Error(`CDEII CSV: missing expected column ${name}`);
  }
  return rows;
}

/** Factor rows; malformed rows (empty DUID, non-numeric factor) are counted, not thrown. */
export function parseFactorsCsv(text: string): { rows: EmissionFactorRow[]; malformed: number } {
  const records = parseCdeiiCsv(text, ['STATIONNAME', 'DUID', 'GENSETID', 'REGIONID', 'CO2E_EMISSIONS_FACTOR']);
  const rows: EmissionFactorRow[] = [];
  let malformed = 0;
  for (const r of records) {
    const duid = r.DUID.trim();
    const factor = r.CO2E_EMISSIONS_FACTOR.trim() === '' ? NaN : Number(r.CO2E_EMISSIONS_FACTOR);
    if (duid === '' || !Number.isFinite(factor) || factor < 0) {
      malformed++;
      continue;
    }
    rows.push({
      duid,
      gensetId: r.GENSETID.trim() || duid,
      stationName: r.STATIONNAME,
      region: r.REGIONID,
      factor,
      energySource: r.CO2E_ENERGY_SOURCE ?? '',
      dataSource: r.CO2E_DATA_SOURCE ?? '',
    });
  }
  return { rows, malformed };
}

/** Official daily index rows; energy/emissions are optional, intensity is not. */
export function parseSummaryCsv(text: string): { rows: CdeiiIndexRow[]; malformed: number } {
  const records = parseCdeiiCsv(text, ['SETTLEMENTDATE', 'REGIONID', 'CO2E_INTENSITY_INDEX']);
  const rows: CdeiiIndexRow[] = [];
  let malformed = 0;
  for (const r of records) {
    const day = parseSettlementDate(r.SETTLEMENTDATE.trim());
    const region = r.REGIONID.trim();
    const intensity = r.CO2E_INTENSITY_INDEX.trim() === '' ? NaN : Number(r.CO2E_INTENSITY_INDEX);
    if (day === null || region === '' || !Number.isFinite(intensity)) {
      malformed++;
      continue;
    }
    const optional = (raw: string | undefined): number | null => {
      const n = Number(raw);
      return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) ? n : null;
    };
    rows.push({
      day,
      region,
      totalEnergy: optional(r.TOTAL_SENT_OUT_ENERGY),
      totalEmissions: optional(r.TOTAL_EMISSIONS),
      intensity,
    });
  }
  return { rows, malformed };
}

/**
 * Replace the factor table and upsert the official index rows, atomically
 * (one D1 batch = one transaction). Exposed separately from the fetch so
 * tests exercise the real write path on fixture text.
 */
export async function ingestEmissions(db: D1Database, factorsCsv: string, summaryCsv: string): Promise<void> {
  const factors = parseFactorsCsv(factorsCsv);
  const summary = parseSummaryCsv(summaryCsv);
  if (factors.malformed > 0) {
    console.warn('emissions: skipped malformed factor row(s)', { op: 'emissions_refresh', file: FACTORS_FILE, malformed: factors.malformed });
  }
  if (summary.malformed > 0) {
    console.warn('emissions: skipped malformed index row(s)', { op: 'emissions_refresh', file: SUMMARY_FILE, malformed: summary.malformed });
  }
  // Zero rows means format drift or a garbage download, never a real state of
  // the NEM — throw before the batch so the previous snapshot stays intact.
  if (factors.rows.length === 0) throw new Error('emissions: no factor rows parsed');
  if (summary.rows.length === 0) throw new Error('emissions: no official index rows parsed');

  // The intensity query joins per-DUID via AVG(factor) over genset rows —
  // exact while AEMO publishes one factor per DUID (true for every DUID as of
  // 2026-08-08). If that ever diverges the average is still served, but it is
  // a methodology change someone must look at: warn with the DUIDs.
  const byDuid = new Map<string, Set<number>>();
  for (const row of factors.rows) {
    let seen = byDuid.get(row.duid);
    if (seen === undefined) {
      seen = new Set();
      byDuid.set(row.duid, seen);
    }
    seen.add(row.factor);
  }
  const conflicting = [...byDuid.entries()].filter(([, f]) => f.size > 1).map(([d]) => d);
  if (conflicting.length > 0) {
    console.warn('emissions: DUID(s) with conflicting genset factors (AVG applies)', {
      op: 'emissions_refresh',
      count: conflicting.length,
      duids: conflicting.sort(),
    });
  }

  const statements: D1PreparedStatement[] = [db.prepare('DELETE FROM emission_factors')];
  const factorChunk = Math.floor(100 / FACTOR_COLS);
  for (let i = 0; i < factors.rows.length; i += factorChunk) {
    const chunk = factors.rows.slice(i, i + factorChunk);
    statements.push(
      db
        .prepare(
          'INSERT INTO emission_factors (duid, genset_id, station_name, region, factor, energy_source, data_source) VALUES ' +
            chunk.map(() => '(?,?,?,?,?,?,?)').join(',') +
            // The file can carry duplicate (DUID, GENSETID) pairs in principle;
            // last row wins rather than failing the whole refresh.
            ' ON CONFLICT(duid, genset_id) DO UPDATE SET station_name = excluded.station_name, ' +
            'region = excluded.region, factor = excluded.factor, ' +
            'energy_source = excluded.energy_source, data_source = excluded.data_source',
        )
        .bind(...chunk.flatMap((r) => [r.duid, r.gensetId, r.stationName, r.region, r.factor, r.energySource, r.dataSource])),
    );
  }
  const indexChunk = Math.floor(100 / INDEX_COLS);
  for (let i = 0; i < summary.rows.length; i += indexChunk) {
    const chunk = summary.rows.slice(i, i + indexChunk);
    statements.push(
      db
        .prepare(
          'INSERT INTO cdeii_index (day, region, total_energy, total_emissions, intensity) VALUES ' +
            chunk.map(() => '(?,?,?,?,?)').join(',') +
            ' ON CONFLICT(day, region) DO UPDATE SET total_energy = excluded.total_energy, ' +
            'total_emissions = excluded.total_emissions, intensity = excluded.intensity',
        )
        .bind(...chunk.flatMap((r) => [r.day, r.region, r.totalEnergy, r.totalEmissions, r.intensity])),
    );
  }
  await db.batch(statements);
  console.log(
    `emissions: refreshed ${factors.rows.length} factor row(s) (${byDuid.size} DUIDs), ` +
      `upserted ${summary.rows.length} official index row(s)`,
  );
}

// Bounds a hung nemweb.com.au response; generous because both files are small
// and the cron is daily — a slow success still beats an aborted refresh.
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Fetch one CDEII file, mapping timeouts, transport errors, and bad statuses
 * to one domain failure. The body read stays inside the try — a timeout that
 * fires mid-body (headers arrived, body stalled) must get the same mapping.
 */
async function fetchCdeiiFile(file: string, baseUrl: string): Promise<string> {
  try {
    const res = await fetch(new URL(file, baseUrl), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    throw new Error(`emissions: fetch failed for ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Cron entry point: fetch both CDEII files and ingest them. */
export async function runEmissionsRefresh(env: Env, baseUrl: string = CDEII_BASE_URL): Promise<void> {
  const [factorsCsv, summaryCsv] = await Promise.all([
    fetchCdeiiFile(FACTORS_FILE, baseUrl),
    fetchCdeiiFile(SUMMARY_FILE, baseUrl),
  ]);
  await ingestEmissions(env.DB, factorsCsv, summaryCsv);
}
