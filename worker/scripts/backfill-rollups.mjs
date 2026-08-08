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

const target = process.argv[2] ?? '--remote';
if (!['--remote', '--local'].includes(target)) {
  console.error('usage: node scripts/backfill-rollups.mjs [--remote|--local]');
  process.exit(1);
}

function d1(command) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'nem-api-db', target, '--json', '--command', command], {
    encoding: 'utf8',
    cwd: new URL('..', import.meta.url).pathname,
  });
  return JSON.parse(out)[0].results;
}

// Bucket-label SQL, identical to src/rollups.ts bucketExpr: period-ending,
// NEM-aligned (AEST = UTC+10, no DST; offset 36000).
const HOUR_BUCKET = '((scrape_time + 39599) / 3600) * 3600 - 36000';
const DAY_OF_HOURLY = '((bucket + 122399) / 86400) * 86400 - 36000';

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

for (let i = 0; i + 1 < edges.length; i++) {
  const rawRange = `scrape_time > ${edges[i]} AND scrape_time <= ${edges[i + 1]}`;
  const hourlyRange = `bucket > ${edges[i]} AND bucket <= ${edges[i + 1]}`;
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
  console.log(`rolled up chunk ${i + 1}/${edges.length - 1} — through ${new Date(edges[i + 1] * 1000).toISOString()}`);
}

// Cheap full-history invariant: every distinct raw interval is counted
// exactly once across scada_intervals.
const [check] = d1(
  'SELECT (SELECT COUNT(DISTINCT scrape_time) FROM scada_values) AS raw_intervals, ' +
    '(SELECT SUM(n_intervals) FROM scada_intervals) AS rolled_intervals, ' +
    '(SELECT COUNT(*) FROM scada_hourly) AS hourly_rows, ' +
    '(SELECT COUNT(*) FROM scada_daily) AS daily_rows',
);
console.log(JSON.stringify(check));
if (check.raw_intervals !== check.rolled_intervals) {
  console.error('MISMATCH: rolled interval count differs from raw — investigate before serving rollups');
  process.exit(1);
}
console.log('rollup backfill complete and consistent');
