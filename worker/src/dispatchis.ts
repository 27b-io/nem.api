// AEMO DispatchIS CSV parsing (LAB-1700) — pure functions, no bindings.
//
// A DispatchIS file is a multi-table MMS CSV (same C/I/D convention as
// Dispatch SCADA, see src/scada.ts) carrying ~7 DISPATCH tables per interval.
// We ingest three:
//
//   DISPATCH,PRICE             → per-region RRP ($/MWh)
//   DISPATCH,REGIONSUM         → per-region TOTALDEMAND (MW)
//   DISPATCH,INTERCONNECTORRES → per-interconnector METEREDMWFLOW (MW)
//
// Unlike the single-table SCADA parser, columns here are resolved BY NAME
// from each table's I header record, not by fixed position: these tables
// carry version numbers (PRICE,5 / REGIONSUM,9 / INTERCONNECTORRES,3 as of
// 2026-08) that AEMO bumps, and a bump can insert columns. Header-indexed
// reads degrade a drift to "column missing → malformed count" instead of
// silently ingesting the wrong field.
//
// INTERVENTION filter: during an AEMO intervention the file carries duplicate
// rows per (interval, region) for the intervention run. Only INTERVENTION=0
// rows are ingested (ticket decision, LAB-1700); intervention duplicates are
// skipped silently — they are a market state, not a malformed row.

import { parseSettlementDate, unquote } from './scada';

export interface RegionRow {
  /** Unix seconds (UTC) of the period-ending dispatch interval. */
  settlementTime: number;
  region: string;
  /** $/MWh; null when the file carried no PRICE row for this (interval, region). */
  rrp: number | null;
  /** MW; null when the file carried no REGIONSUM row for this (interval, region). */
  totalDemand: number | null;
}

export interface InterconnectorRow {
  settlementTime: number;
  interconnector: string;
  /** Signed MW; negative = flow against the interconnector's defined direction. */
  meteredMwFlow: number;
}

export interface DispatchIsBatch {
  regions: RegionRow[];
  interconnectors: InterconnectorRow[];
}

// table name → the column carrying its entity id and its value.
const TABLE_COLUMNS: Record<string, { idCol: string; valueCol: string }> = {
  PRICE: { idCol: 'REGIONID', valueCol: 'RRP' },
  REGIONSUM: { idCol: 'REGIONID', valueCol: 'TOTALDEMAND' },
  INTERCONNECTORRES: { idCol: 'INTERCONNECTORID', valueCol: 'METEREDMWFLOW' },
};

/**
 * Extract PRICE / REGIONSUM / INTERCONNECTORRES rows from a DispatchIS CSV,
 * INTERVENTION=0 rows only. PRICE and REGIONSUM rows for the same (interval,
 * region) merge onto one RegionRow. Malformed data rows (bad date, missing
 * header, empty id, non-numeric value, absent INTERVENTION column) are
 * counted, not thrown — one bad row cannot sink the file; the caller logs
 * the count.
 */
export function parseDispatchIsCsv(text: string): { batch: DispatchIsBatch; malformed: number } {
  // Per-table column-name → index maps, built from the I header records.
  const headers = new Map<string, Map<string, number>>();
  const regionsByKey = new Map<string, RegionRow>();
  const interconnectors: InterconnectorRow[] = [];
  let malformed = 0;

  for (const line of text.split(/\r?\n/)) {
    const kind = line.startsWith('I,DISPATCH,') ? 'I' : line.startsWith('D,DISPATCH,') ? 'D' : null;
    if (kind === null) continue;
    const cols = line.split(',');
    const table = cols[2];
    const spec = TABLE_COLUMNS[table];
    if (spec === undefined) continue;

    if (kind === 'I') {
      headers.set(table, new Map(cols.map((name, i) => [name, i])));
      continue;
    }

    const header = headers.get(table);
    if (header === undefined) {
      // A D row before its I record — format drift, never seen live.
      malformed++;
      continue;
    }
    const field = (name: string): string => unquote(cols[header.get(name) ?? -1] ?? '').trim();

    const intervention = field('INTERVENTION');
    if (intervention === '') {
      // Missing INTERVENTION column: counting it malformed (not "assume 0")
      // keeps an AEMO header drift loud instead of silently double-ingesting
      // intervention duplicates.
      malformed++;
      continue;
    }
    if (intervention !== '0') continue; // intervention-run duplicate, skip silently

    const settlementTime = parseSettlementDate(field('SETTLEMENTDATE'));
    const id = field(spec.idCol);
    const rawValue = field(spec.valueCol);
    const value = rawValue === '' ? NaN : Number(rawValue);
    if (settlementTime === null || id === '' || !Number.isFinite(value)) {
      malformed++;
      continue;
    }

    if (table === 'INTERCONNECTORRES') {
      interconnectors.push({ settlementTime, interconnector: id, meteredMwFlow: value });
      continue;
    }
    const key = `${settlementTime}|${id}`;
    let row = regionsByKey.get(key);
    if (row === undefined) {
      row = { settlementTime, region: id, rrp: null, totalDemand: null };
      regionsByKey.set(key, row);
    }
    if (table === 'PRICE') row.rrp = value;
    else row.totalDemand = value;
  }

  return { batch: { regions: [...regionsByKey.values()], interconnectors }, malformed };
}
