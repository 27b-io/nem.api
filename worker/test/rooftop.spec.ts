// LAB-1701: ROOFTOP,ACTUAL parsing invariants — MEASUREMENT-only ingestion,
// header-indexed columns (versioned table), malformed rows counted not thrown.
import { describe, expect, it } from 'vitest';
import { parseRooftopPvCsv } from '../src/rooftop';

// Shape captured from the live NEMWEB file on 2026-08-09
// (PUBLIC_ROOFTOP_PV_ACTUAL_MEASUREMENT_20260809080000_…zip).
const HEADER = 'I,ROOFTOP,ACTUAL,2,INTERVAL_DATETIME,REGIONID,POWER,QI,TYPE,LASTCHANGED';
const LIVE_CSV = [
  'C,NEMP.WORLD,ROOFTOP_PV_ACTUAL_MEASUREMENT,AEMO,PUBLIC,2026/08/09,08:00:03,0000000531718665,DEMAND,0000000531718665',
  HEADER,
  'D,ROOFTOP,ACTUAL,2,"2026/08/09 07:30:00",NSW1,302.483,1,MEASUREMENT,"2026/08/09 07:49:02"',
  'D,ROOFTOP,ACTUAL,2,"2026/08/09 07:30:00",QLD1,522.8,0.7,MEASUREMENT,"2026/08/09 07:49:02"',
  'D,ROOFTOP,ACTUAL,2,"2026/08/09 07:30:00",SA1,0,1,MEASUREMENT,"2026/08/09 07:49:02"',
  'C,"END OF REPORT",8',
  '',
].join('\r\n');

// "2026/08/09 07:30:00" NEM market time (UTC+10).
const T = Date.UTC(2026, 7, 9, 7, 30, 0) / 1000 - 10 * 3600;

describe('parseRooftopPvCsv', () => {
  it('parses MEASUREMENT rows from a live-shaped file: period-ending time, MW, QI', () => {
    const { rows, malformed } = parseRooftopPvCsv(LIVE_CSV);
    expect(malformed).toBe(0);
    expect(rows).toEqual([
      { intervalTime: T, region: 'NSW1', power: 302.483, quality: 1 },
      { intervalTime: T, region: 'QLD1', power: 522.8, quality: 0.7 },
      { intervalTime: T, region: 'SA1', power: 0, quality: 1 }, // a true zero is a reading, not a gap
    ]);
  });

  it('skips SATELLITE rows silently — an alternative estimate is not a malformed row', () => {
    const csv = [
      HEADER,
      'D,ROOFTOP,ACTUAL,2,"2026/08/09 07:30:00",NSW1,300,1,SATELLITE,"x"',
      'D,ROOFTOP,ACTUAL,2,"2026/08/09 07:30:00",VIC1,1.5,1,MEASUREMENT,"x"',
    ].join('\n');
    const { rows, malformed } = parseRooftopPvCsv(csv);
    expect(malformed).toBe(0);
    expect(rows).toEqual([{ intervalTime: T, region: 'VIC1', power: 1.5, quality: 1 }]);
  });

  it('resolves columns by NAME from the I record, so an AEMO column insert cannot shift fields', () => {
    const csv = [
      'I,ROOFTOP,ACTUAL,3,INTERVAL_DATETIME,NEW_COLUMN,REGIONID,POWER,QI,TYPE,LASTCHANGED',
      'D,ROOFTOP,ACTUAL,3,"2026/08/09 07:30:00",surprise,TAS1,0.271,1,MEASUREMENT,"x"',
    ].join('\n');
    expect(parseRooftopPvCsv(csv).rows).toEqual([{ intervalTime: T, region: 'TAS1', power: 0.271, quality: 1 }]);
  });

  it('counts malformed rows (bad date, empty region, non-numeric power, missing TYPE) without sinking the file', () => {
    const csv = [
      HEADER,
      'D,ROOFTOP,ACTUAL,2,"2026/02/30 07:30:00",NSW1,300,1,MEASUREMENT,"x"', // calendar-invalid date
      'D,ROOFTOP,ACTUAL,2,"2026/08/09 07:30:00",,300,1,MEASUREMENT,"x"', // empty region
      'D,ROOFTOP,ACTUAL,2,"2026/08/09 07:30:00",NSW1,oops,1,MEASUREMENT,"x"', // non-numeric power
      'D,ROOFTOP,ACTUAL,2,"2026/08/09 07:30:00",QLD1,500,0.7,MEASUREMENT,"x"', // good
    ].join('\n');
    const { rows, malformed } = parseRooftopPvCsv(csv);
    expect(malformed).toBe(3);
    expect(rows).toEqual([{ intervalTime: T, region: 'QLD1', power: 500, quality: 0.7 }]);
  });

  it('a header without TYPE makes every data row malformed — estimate methods must never silently mix', () => {
    const csv = [
      'I,ROOFTOP,ACTUAL,2,INTERVAL_DATETIME,REGIONID,POWER,QI,LASTCHANGED',
      'D,ROOFTOP,ACTUAL,2,"2026/08/09 07:30:00",NSW1,300,1,"x"',
    ].join('\n');
    expect(parseRooftopPvCsv(csv)).toEqual({ rows: [], malformed: 1 });
  });

  it('a D row before its I record is malformed (format drift, never seen live)', () => {
    const csv = 'D,ROOFTOP,ACTUAL,2,"2026/08/09 07:30:00",NSW1,300,1,MEASUREMENT,"x"';
    expect(parseRooftopPvCsv(csv)).toEqual({ rows: [], malformed: 1 });
  });

  it('an empty or absent QI stores null, not NaN or zero', () => {
    const csv = [HEADER, 'D,ROOFTOP,ACTUAL,2,"2026/08/09 07:30:00",NSW1,300,,MEASUREMENT,"x"'].join('\n');
    expect(parseRooftopPvCsv(csv).rows[0].quality).toBeNull();
  });
});
