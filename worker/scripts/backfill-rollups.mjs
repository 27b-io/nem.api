#!/usr/bin/env node
// Rollup backfill / repair (LAB-1696) — rebuilds scada_hourly,
// scada_intervals and scada_daily from scada_values via `wrangler d1
// execute`, one AEST month per chunk. See worker/README.md ("Aggregate
// rollups") for when to run this.
//
// Why chunked: a single full-history GROUP BY over ~50M raw rows dies on
// D1's SQLite memory budget (SQLITE_NOMEM — the very ceiling the rollups
// exist to avoid); an AEST-month chunk peaks around ~4.5M scanned rows,
// comfortably inside it. Chunk edges are AEST midnights, so they are both
// hourly and daily bucket-label boundaries: no bucket ever spans a chunk,
// every chunk recomputes whole buckets, and re-running any chunk — or the
// whole script — is idempotent.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const target = process.argv[2] ?? '--remote';
if (!['--remote', '--local'].includes(target)) {
  console.error('usage: node scripts/backfill-rollups.mjs [--remote|--local]');
  process.exit(1);
}

function d1(command) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'nem-api-db', target, '--json', '--command', command], {
    encoding: 'utf8',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
  });
  return JSON.parse(out)[0].results;
}

// Bucket-label SQL, derived the same way as src/rollups.ts bucketExpr so the
// arithmetic visibly mirrors it: period-ending, NEM-aligned (AEST = UTC+10,
// no DST).
const OFF = 36000;
const HOUR_BUCKET = `((scrape_time + ${OFF + 3600 - 1}) / 3600) * 3600 - ${OFF}`;
const DAY_OF_HOURLY = `((bucket + ${OFF + 86400 - 1}) / 86400) * 86400 - ${OFF}`;

const [{ lo, hi }] = d1('SELECT MIN(scrape_time) AS lo, MAX(scrape_time) AS hi FROM scada_values');
if (lo === null) {
  console.log('scada_values is empty — nothing to roll up');
  process.exit(0);
}

// AEST month edges covering (firstEdge, lastEdge] ⊇ all samples. The first
// edge steps one extra day back so a sample sitting exactly on the oldest
// month boundary still lands inside the first half-open chunk.
const AEST = 10 * 3600;
const monthStart = (unix) => {
  const d = new Date((unix + AEST) * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000 - AEST;
};
const nextMonth = (edge) => {
  const d = new Date((edge + AEST) * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000 - AEST;
};
const edges = [monthStart(lo) - 86400, monthStart(lo)];
while (edges[edges.length - 1] < hi) edges.push(nextMonth(edges[edges.length - 1]));

// Consistency-check cutoff, captured BEFORE the loop: the last hour bucket
// already complete at start. Intervals the live ingest lands during the run
// sit above this bound on both sides of the final check.
const cutoff = Math.ceil((hi + OFF) / 3600) * 3600 - OFF - 3600;

for (let i = 0; i + 1 < edges.length; i++) {
  const rawRange = `scrape_time > ${edges[i]} AND scrape_time <= ${edges[i + 1]}`;
  const hourlyRange = `bucket > ${edges[i]} AND bucket <= ${edges[i + 1]}`;
  try {
    runChunk(rawRange, hourlyRange);
  } catch (err) {
    // A chunk's three statements are separate transactions: a partial chunk
    // can leave scada_hourly rows without their scada_intervals twin, and the
    // aggregate's inner join then silently drops those buckets from public
    // responses. Never serve rollups off a failed run.
    console.error(`CHUNK FAILED for range (${edges[i]}, ${edges[i + 1]}]:`, err instanceof Error ? err.message : err);
    console.error('Rollups are INCOMPLETE — re-run this script to completion before deploying/serving the rollup path.');
    process.exit(1);
  }
  console.log(`rolled up chunk ${i + 1}/${edges.length - 1} — through ${new Date(edges[i + 1] * 1000).toISOString()}`);
}

function runChunk(rawRange, hourlyRange) {
  d1(
    'INSERT INTO scada_hourly (bucket, generator_id, sum_value, n_samples) ' +
      `SELECT ${HOUR_BUCKET} AS hour_bucket, generator_id, SUM(value), COUNT(*) ` +
      `FROM scada_values WHERE ${rawRange} GROUP BY hour_bucket, generator_id ` +
      'ON CONFLICT(bucket, generator_id) DO UPDATE SET sum_value = excluded.sum_value, n_samples = excluded.n_samples',
  );
  d1(
    'INSERT INTO scada_intervals (bucket, n_intervals) ' +
      `SELECT ${HOUR_BUCKET} AS hour_bucket, COUNT(DISTINCT scrape_time) ` +
      `FROM scada_values WHERE ${rawRange} GROUP BY hour_bucket ` +
      'ON CONFLICT(bucket) DO UPDATE SET n_intervals = excluded.n_intervals',
  );
  d1(
    'INSERT INTO scada_daily (bucket, generator_id, sum_value, n_samples) ' +
      `SELECT ${DAY_OF_HOURLY} AS day_bucket, generator_id, SUM(sum_value), SUM(n_samples) ` +
      `FROM scada_hourly WHERE ${hourlyRange} GROUP BY day_bucket, generator_id ` +
      'ON CONFLICT(bucket, generator_id) DO UPDATE SET sum_value = excluded.sum_value, n_samples = excluded.n_samples',
  );
}

// Cheap full-history invariant, bounded at the pre-run cutoff so the live
// ingest crons can't skew it: every distinct raw interval counted exactly
// once across scada_intervals.
const [check] = d1(
  `SELECT (SELECT COUNT(DISTINCT scrape_time) FROM scada_values WHERE scrape_time <= ${cutoff}) AS raw_intervals, ` +
    `(SELECT SUM(n_intervals) FROM scada_intervals WHERE bucket <= ${cutoff}) AS rolled_intervals, ` +
    '(SELECT COUNT(*) FROM scada_hourly) AS hourly_rows, ' +
    '(SELECT COUNT(*) FROM scada_daily) AS daily_rows',
);
console.log(JSON.stringify(check));
if (check.raw_intervals !== check.rolled_intervals) {
  console.error(
    'MISMATCH: rolled interval count differs from raw. Re-run this script first — a concurrent ' +
      'ARCHIVE-backfill tick landing historical rows mid-run can trip this transiently; a mismatch ' +
      'that PERSISTS across a re-run is the real signal. Do not serve rollups until it clears.',
  );
  process.exit(1);
}
console.log('rollup backfill complete and consistent');
