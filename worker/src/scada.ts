// AEMO Dispatch SCADA CSV parsing — pure functions, no bindings.
//
// AEMO CSVs are "multi-table" flat files: C rows are comments/trailers, I rows
// declare a table's columns, D rows carry data for that table. Dispatch SCADA
// files hold a single table:
//
//   I,DISPATCH,UNIT_SCADA,1,SETTLEMENTDATE,DUID,SCADAVALUE,LASTCHANGED
//   D,DISPATCH,UNIT_SCADA,1,"2026/07/23 23:35:00",BARCSF1,0.10,"2026/07/23 23:30:14"
//
// The format has been stable 15+ years and its quoted fields (the two
// timestamps) never contain commas, so split-on-comma plus quote stripping is
// a correct parse for this table. Rows are filtered on the full
// D,DISPATCH,UNIT_SCADA prefix (stricter than the legacy scraper's bare "D"
// check) so another table interleaved into the file cannot be misread.

export interface ScadaRow {
  /** Unix seconds (UTC) of the dispatch interval (SETTLEMENTDATE). */
  scrapeTime: number;
  duid: string;
  /** MW output; negative for units drawing power (batteries, station load). */
  value: number;
}

const DATA_PREFIX = 'D,DISPATCH,UNIT_SCADA,';

// NEM market time is AEST (UTC+10) year-round — the market runs on Queensland
// time and never observes daylight saving, so a fixed offset is correct.
const NEM_UTC_OFFSET_SECONDS = 10 * 3600;

const SETTLEMENT_DATE = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** "2026/07/23 23:35:00" (NEM market time) → unix seconds, or null if malformed. */
export function parseSettlementDate(text: string): number | null {
  const m = SETTLEMENT_DATE.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  // Date.UTC silently normalizes calendar-invalid input (2026/02/30 → March 2,
  // 25:00 → next day 01:00), which would ingest a corrupted row under the
  // wrong scrape_time. Round-trip the components so those return null instead.
  const rt = new Date(ms);
  if (
    rt.getUTCFullYear() !== +y ||
    rt.getUTCMonth() !== +mo - 1 ||
    rt.getUTCDate() !== +d ||
    rt.getUTCHours() !== +h ||
    rt.getUTCMinutes() !== +mi ||
    rt.getUTCSeconds() !== +s
  ) {
    return null;
  }
  return ms / 1000 - NEM_UTC_OFFSET_SECONDS;
}

/** Strip the MMS CSV quoting convention (quoted fields never contain commas). */
export function unquote(field: string): string {
  return field.startsWith('"') && field.endsWith('"') && field.length >= 2 ? field.slice(1, -1) : field;
}

/**
 * Extract UNIT_SCADA data rows from a Dispatch SCADA CSV. Malformed data rows
 * (bad date, empty DUID, non-numeric value) are counted, not thrown, so one
 * bad row cannot sink the rest of the file — the caller logs the count.
 */
export function parseUnitScadaCsv(text: string): { rows: ScadaRow[]; malformed: number } {
  const rows: ScadaRow[] = [];
  let malformed = 0;

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(DATA_PREFIX)) continue;

    // 0=D 1=DISPATCH 2=UNIT_SCADA 3=version 4=SETTLEMENTDATE 5=DUID 6=SCADAVALUE 7=LASTCHANGED
    const cols = line.split(',');
    const scrapeTime = parseSettlementDate(unquote(cols[4] ?? ''));
    const duid = unquote(cols[5] ?? '').trim();
    const rawValue = unquote(cols[6] ?? '').trim();
    const value = rawValue === '' ? NaN : Number(rawValue);

    if (scrapeTime === null || duid === '' || !Number.isFinite(value)) {
      malformed++;
      continue;
    }
    rows.push({ scrapeTime, duid, value });
  }

  return { rows, malformed };
}
