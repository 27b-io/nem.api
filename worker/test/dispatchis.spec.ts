import { describe, expect, it } from 'vitest';
import { parseDispatchIsCsv } from '../src/dispatchis';

// Column layout captured verbatim from the live NEMWEB file
// PUBLIC_DISPATCHIS_202608082025_0000000531645400.zip on 2026-08-08 (headers
// truncated after the columns under test — the parser resolves columns by
// name from the I record, so trailing columns are irrelevant).
const CAPTURED_CSV =
  'C,NEMP.WORLD,DISPATCHIS,AEMO,PUBLIC,2026/08/08,20:20:04,0000000531645400,DISPATCHIS,0000000531645389\r\n' +
  'I,DISPATCH,CASE_SOLUTION,2,SETTLEMENTDATE,RUNNO,INTERVENTION,CASESUBTYPE,SOLUTIONSTATUS\r\n' +
  'D,DISPATCH,CASE_SOLUTION,2,"2026/08/08 20:25:00",1,0,,0\r\n' +
  'I,DISPATCH,PRICE,5,SETTLEMENTDATE,RUNNO,REGIONID,DISPATCHINTERVAL,INTERVENTION,RRP,EEP\r\n' +
  'D,DISPATCH,PRICE,5,"2026/08/08 20:25:00",1,NSW1,20260808197,0,110.01,0\r\n' +
  'D,DISPATCH,PRICE,5,"2026/08/08 20:25:00",1,SA1,20260808197,0,-8.51,0\r\n' +
  'I,DISPATCH,REGIONSUM,9,SETTLEMENTDATE,RUNNO,REGIONID,DISPATCHINTERVAL,INTERVENTION,TOTALDEMAND,AVAILABLEGENERATION\r\n' +
  'D,DISPATCH,REGIONSUM,9,"2026/08/08 20:25:00",1,NSW1,20260808197,0,9655.98,13390.10098\r\n' +
  'D,DISPATCH,REGIONSUM,9,"2026/08/08 20:25:00",1,SA1,20260808197,0,1760.17,3756.49032\r\n' +
  'I,DISPATCH,INTERCONNECTORRES,3,SETTLEMENTDATE,RUNNO,INTERCONNECTORID,DISPATCHINTERVAL,INTERVENTION,METEREDMWFLOW,MWFLOW\r\n' +
  'D,DISPATCH,INTERCONNECTORRES,3,"2026/08/08 20:25:00",1,VIC1-NSW1,20260808197,0,899.07507,854.85024\r\n' +
  'D,DISPATCH,INTERCONNECTORRES,3,"2026/08/08 20:25:00",1,V-SA,20260808197,0,-79.32227,-92.90617\r\n' +
  'C,"END OF REPORT",1329\r\n';

// 2026-08-08 20:25 NEM market time (AEST, UTC+10) == 2026-08-08 10:25 UTC.
const T = Date.UTC(2026, 7, 8, 10, 25, 0) / 1000;

describe('parseDispatchIsCsv', () => {
  it('parses captured PRICE/REGIONSUM/INTERCONNECTORRES rows, merging region tables onto one row', () => {
    const { batch, malformed } = parseDispatchIsCsv(CAPTURED_CSV);
    expect(malformed).toBe(0);
    expect(batch.regions).toEqual([
      { settlementTime: T, region: 'NSW1', rrp: 110.01, totalDemand: 9655.98 },
      // Negative price is a routine NEM state and must pass through.
      { settlementTime: T, region: 'SA1', rrp: -8.51, totalDemand: 1760.17 },
    ]);
    expect(batch.interconnectors).toEqual([
      { settlementTime: T, interconnector: 'VIC1-NSW1', meteredMwFlow: 899.07507 },
      // Negative flow (against defined direction) is routine too.
      { settlementTime: T, interconnector: 'V-SA', meteredMwFlow: -79.32227 },
    ]);
  });

  it('skips INTERVENTION!=0 duplicates silently — a market state, not a malformed row', () => {
    const csv =
      'I,DISPATCH,PRICE,5,SETTLEMENTDATE,RUNNO,REGIONID,DISPATCHINTERVAL,INTERVENTION,RRP\r\n' +
      'D,DISPATCH,PRICE,5,"2026/08/08 20:25:00",1,NSW1,20260808197,0,110.01\r\n' +
      'D,DISPATCH,PRICE,5,"2026/08/08 20:25:00",1,NSW1,20260808197,1,300\r\n';
    const { batch, malformed } = parseDispatchIsCsv(csv);
    expect(malformed).toBe(0);
    expect(batch.regions).toEqual([{ settlementTime: T, region: 'NSW1', rrp: 110.01, totalDemand: null }]);
  });

  it('resolves columns by header name, so an AEMO version bump inserting columns still parses', () => {
    // Hypothetical PRICE,6 with a new column spliced in before RRP.
    const csv =
      'I,DISPATCH,PRICE,6,SETTLEMENTDATE,RUNNO,REGIONID,DISPATCHINTERVAL,INTERVENTION,NEWFLAG,RRP\r\n' +
      'D,DISPATCH,PRICE,6,"2026/08/08 20:25:00",1,NSW1,20260808197,0,7,110.01\r\n';
    const { batch, malformed } = parseDispatchIsCsv(csv);
    expect(malformed).toBe(0);
    expect(batch.regions).toEqual([{ settlementTime: T, region: 'NSW1', rrp: 110.01, totalDemand: null }]);
  });

  it('counts malformed rows instead of throwing: bad date, empty id, non-numeric value, headerless D row', () => {
    const csv =
      'D,DISPATCH,PRICE,5,"2026/08/08 20:25:00",1,EARLY1,20260808197,0,1\r\n' + // D before its I record
      'I,DISPATCH,PRICE,5,SETTLEMENTDATE,RUNNO,REGIONID,DISPATCHINTERVAL,INTERVENTION,RRP\r\n' +
      'D,DISPATCH,PRICE,5,"not a date",1,NSW1,20260808197,0,1\r\n' +
      'D,DISPATCH,PRICE,5,"2026/08/08 20:25:00",1,,20260808197,0,1\r\n' +
      'D,DISPATCH,PRICE,5,"2026/08/08 20:25:00",1,NSW1,20260808197,0,not-a-number\r\n' +
      'D,DISPATCH,PRICE,5,"2026/08/08 20:25:00",1,OK1,20260808197,0,42\r\n';
    const { batch, malformed } = parseDispatchIsCsv(csv);
    expect(malformed).toBe(4);
    expect(batch.regions).toEqual([{ settlementTime: T, region: 'OK1', rrp: 42, totalDemand: null }]);
  });

  it('counts every row malformed when the INTERVENTION column vanishes — drift must be loud, not double-ingested', () => {
    const csv =
      'I,DISPATCH,PRICE,6,SETTLEMENTDATE,RUNNO,REGIONID,DISPATCHINTERVAL,RRP\r\n' +
      'D,DISPATCH,PRICE,6,"2026/08/08 20:25:00",1,NSW1,20260808197,110.01\r\n';
    const { batch, malformed } = parseDispatchIsCsv(csv);
    expect(malformed).toBe(1);
    expect(batch.regions).toEqual([]);
  });

  it('ignores tables it does not ingest and non-DISPATCH rows', () => {
    const { batch, malformed } = parseDispatchIsCsv(
      'I,DISPATCH,CONSTRAINT,5,SETTLEMENTDATE,RUNNO,CONSTRAINTID,DISPATCHINTERVAL,INTERVENTION,RHS\r\n' +
        'D,DISPATCH,CONSTRAINT,5,"2026/08/08 20:25:00",1,X_1,20260808197,0,1\r\n' +
        'D,TRADING,PRICE,3,"2026/08/08 20:25:00",1,NSW1,1,0,99\r\n',
    );
    expect(malformed).toBe(0);
    expect(batch.regions).toEqual([]);
    expect(batch.interconnectors).toEqual([]);
  });
});
