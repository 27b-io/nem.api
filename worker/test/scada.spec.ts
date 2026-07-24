import { describe, expect, it } from 'vitest';
import { parseSettlementDate, parseUnitScadaCsv } from '../src/scada';

// Captured verbatim (incl. CRLF) from the live NEMWEB file
// PUBLIC_DISPATCHSCADA_202607232335_0000000528917241.zip on 2026-07-23.
const CAPTURED_CSV =
  'C,NEMP.WORLD,DISPATCHSCADA,AEMO,PUBLIC,2026/07/23,23:30:15,0000000528917241,DISPATCHSCADA,0000000528917235\r\n' +
  'I,DISPATCH,UNIT_SCADA,1,SETTLEMENTDATE,DUID,SCADAVALUE,LASTCHANGED\r\n' +
  'D,DISPATCH,UNIT_SCADA,1,"2026/07/23 23:35:00",BARCSF1,0.10,"2026/07/23 23:30:14"\r\n' +
  'D,DISPATCH,UNIT_SCADA,1,"2026/07/23 23:35:00",HUGSF1,-0.10,"2026/07/23 23:30:14"\r\n' +
  'D,DISPATCH,UNIT_SCADA,1,"2026/07/23 23:35:00",MURRAY,0,"2026/07/23 23:30:14"\r\n' +
  'C,"END OF REPORT",516\r\n';

// 2026-07-23 23:35 NEM market time (AEST, UTC+10) == 2026-07-23 13:35 UTC.
const EXPECTED_TIME = Date.UTC(2026, 6, 23, 13, 35, 0) / 1000;

describe('parseUnitScadaCsv', () => {
  it('parses captured UNIT_SCADA rows, ignoring C/I rows and the trailer', () => {
    const { rows, malformed } = parseUnitScadaCsv(CAPTURED_CSV);
    expect(malformed).toBe(0);
    expect(rows).toEqual([
      { scrapeTime: EXPECTED_TIME, duid: 'BARCSF1', value: 0.1 },
      { scrapeTime: EXPECTED_TIME, duid: 'HUGSF1', value: -0.1 },
      { scrapeTime: EXPECTED_TIME, duid: 'MURRAY', value: 0 },
    ]);
  });

  it('counts malformed data rows instead of throwing', () => {
    const bad =
      'D,DISPATCH,UNIT_SCADA,1,"not a date",BARCSF1,0.10,"2026/07/23 23:30:14"\n' +
      'D,DISPATCH,UNIT_SCADA,1,"2026/07/23 23:35:00",,0.10,"2026/07/23 23:30:14"\n' +
      'D,DISPATCH,UNIT_SCADA,1,"2026/07/23 23:35:00",BARCSF1,,"2026/07/23 23:30:14"\n' +
      'D,DISPATCH,UNIT_SCADA,1,"2026/07/23 23:35:00",OK1,1.5,"2026/07/23 23:30:14"\n';
    const { rows, malformed } = parseUnitScadaCsv(bad);
    expect(malformed).toBe(3);
    expect(rows).toEqual([{ scrapeTime: EXPECTED_TIME, duid: 'OK1', value: 1.5 }]);
  });

  it('ignores D rows belonging to other tables', () => {
    const other = 'D,DISPATCH,PRICE,1,"2026/07/23 23:35:00",NSW1,100.0,"2026/07/23 23:30:14"\n';
    const { rows, malformed } = parseUnitScadaCsv(other);
    expect(rows).toEqual([]);
    expect(malformed).toBe(0);
  });
});

describe('parseSettlementDate', () => {
  it('converts NEM market time (fixed UTC+10) to unix seconds', () => {
    expect(parseSettlementDate('2026/07/23 23:35:00')).toBe(EXPECTED_TIME);
  });

  it('returns null on malformed input', () => {
    expect(parseSettlementDate('2026-07-23 23:35:00')).toBeNull();
    expect(parseSettlementDate('')).toBeNull();
  });

  it('rejects calendar-invalid dates instead of letting Date.UTC roll them over', () => {
    expect(parseSettlementDate('2026/02/30 12:00:00')).toBeNull(); // would roll to Mar 2
    expect(parseSettlementDate('2026/13/01 12:00:00')).toBeNull(); // month 13
    expect(parseSettlementDate('2026/07/23 25:00:00')).toBeNull(); // hour 25
    expect(parseSettlementDate('2026/07/23 23:61:00')).toBeNull(); // minute 61
    expect(parseSettlementDate('2024/02/29 12:00:00')).toBe(Date.UTC(2024, 1, 29, 2, 0, 0) / 1000); // real leap day still parses
  });
});
