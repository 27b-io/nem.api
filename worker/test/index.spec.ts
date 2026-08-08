import { describe, expect, it } from 'vitest';
import { BACKFILL_CRON } from '../src/backfill';
import { CDEII_CRON } from '../src/cdeii';
import * as entrypoint from '../src/index';
import wranglerToml from '../wrangler.toml?raw';

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

// The scheduled handler dispatches on EXACT cron-string equality and falls
// through to the ingest for anything it doesn't recognise. That makes drift
// between a constant and wrangler.toml completely silent: the schedule fires,
// an extra (successful) ingest runs, and the job that was supposed to run
// never does — no failed invocation, no log, just data quietly going stale.
describe('cron schedules', () => {
  it('are declared in wrangler.toml exactly as the dispatcher expects', () => {
    const blocks = [...wranglerToml.matchAll(/crons\s*=\s*\[([^\]]*)\]/g)];
    expect(blocks, 'wrangler.toml must declare exactly one crons array').toHaveLength(1);
    const declared = [...blocks[0][1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    // Set equality, both directions: a constant wrangler.toml dropped AND a
    // wrangler.toml cron no constant matches (which would silently fall
    // through to the ingest). '*/5 * * * *' IS the ingest fall-through — the
    // one schedule that has no constant, pinned here instead.
    expect(declared).toEqual(['*/5 * * * *', BACKFILL_CRON, CDEII_CRON].sort());
  });
});
