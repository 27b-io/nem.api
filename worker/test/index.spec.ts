import { describe, expect, it } from 'vitest';
import * as entrypoint from '../src/index';

// Regression guard for a whole class of "the Worker will not boot" errors that
// no other test in this suite can see: workerd reads every NAMED export of the
// entrypoint module as an entry in the Worker's handler map, and refuses to
// start on anything that is not a function or an ExportedHandler —
//
//   Uncaught TypeError: Incorrect type for map entry 'CDEII_CRON':
//   the provided value is not of type 'function or ExportedHandler'.
//
// caught live on `wrangler dev` (LAB-1698), not by the suite: the vitest pool
// imports the default handler object and calls .fetch()/.scheduled() on it
// directly, so the runtime's validation never runs. Constants belong beside
// their runner (BACKFILL_CRON in src/backfill.ts, CDEII_CRON in src/cdeii.ts).
describe('worker entrypoint', () => {
  it('exports nothing but the default handler', () => {
    const named = Object.keys(entrypoint).filter((k) => k !== 'default');
    expect(named).toEqual([]);
  });

  it('exposes both handlers workerd will look for', () => {
    expect(typeof entrypoint.default.fetch).toBe('function');
    expect(typeof entrypoint.default.scheduled).toBe('function');
  });
});
