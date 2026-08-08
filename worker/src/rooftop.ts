// AEMO rooftop PV actuals CSV parsing (LAB-1701) — pure functions, no bindings.
//
// ROOFTOP_PV/ACTUAL files carry one table in the MMS C/I/D convention:
//
//   I,ROOFTOP,ACTUAL,2,INTERVAL_DATETIME,REGIONID,POWER,QI,TYPE,LASTCHANGED
//   D,ROOFTOP,ACTUAL,2,"2026/08/09 07:30:00",NSW1,302.483,1,MEASUREMENT,"..."
//
// POWER is AEMO's estimate of distributed rooftop PV generation (MW) for the
// half-hour ENDING at INTERVAL_DATETIME — an estimate published ~30 minutes
// after the interval closes, not SCADA telemetry. Columns are resolved BY NAME
// from the I record (the table is versioned — 2 as of 2026-08 — and a bump can
// insert columns; same rationale as src/dispatchis.ts).
//
// TYPE filter: we ingest MEASUREMENT rows only. SATELLITE is AEMO's
// alternative estimation method, published as separate files in the same
// folders; those files never reach this parser (feed-level filename filter),
// but the row filter here keeps a mixed-type file from double-ingesting an
// interval — last-write-wins on the (interval, region) PK would otherwise
// depend on row order.

import { parseSettlementDate, unquote } from './scada';

export interface RooftopRow {
  /** Unix seconds (UTC) of the period-ENDING half-hour (INTERVAL_DATETIME). */
  intervalTime: number;
  region: string;
  /** MW, AEMO estimate of distributed rooftop PV generation. */
  power: number;
  /** Estimate quality indicator 0..1; null when the file omits it. */
  quality: number | null;
}

/**
 * Extract MEASUREMENT-type ROOFTOP,ACTUAL rows. Malformed data rows (bad
 * date, empty region, non-numeric power, missing TYPE) are counted, not
 * thrown — one bad row cannot sink the file; the caller logs the count.
 * SATELLITE rows are skipped silently: they are a valid alternative estimate,
 * not a malformed row.
 */
export function parseRooftopPvCsv(text: string): { rows: RooftopRow[]; malformed: number } {
  let header: Map<string, number> | undefined;
  const rows: RooftopRow[] = [];
  let malformed = 0;

  for (const line of text.split(/\r?\n/)) {
    const kind = line.startsWith('I,ROOFTOP,ACTUAL,') ? 'I' : line.startsWith('D,ROOFTOP,ACTUAL,') ? 'D' : null;
    if (kind === null) continue;
    const cols = line.split(',');

    if (kind === 'I') {
      header = new Map(cols.map((name, i) => [name, i]));
      continue;
    }
    if (header === undefined) {
      // A D row before its I record — format drift, never seen live.
      malformed++;
      continue;
    }
    const idx = header;
    const field = (name: string): string => unquote(cols[idx.get(name) ?? -1] ?? '').trim();

    const type = field('TYPE');
    if (type === '') {
      // Missing TYPE column: counting it malformed (not "assume MEASUREMENT")
      // keeps an AEMO header drift loud instead of silently mixing estimate
      // methods.
      malformed++;
      continue;
    }
    if (type !== 'MEASUREMENT') continue; // SATELLITE (or future) variant, skip silently

    const intervalTime = parseSettlementDate(field('INTERVAL_DATETIME'));
    const region = field('REGIONID');
    const rawPower = field('POWER');
    const power = rawPower === '' ? NaN : Number(rawPower);
    if (intervalTime === null || region === '' || !Number.isFinite(power)) {
      malformed++;
      continue;
    }
    const rawQi = field('QI');
    const qi = rawQi === '' ? null : Number(rawQi);

    rows.push({ intervalTime, region, power, quality: qi !== null && Number.isFinite(qi) ? qi : null });
  }

  return { rows, malformed };
}
