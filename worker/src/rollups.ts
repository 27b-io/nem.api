// Rollup maintenance (LAB-1696): per-generator hourly/daily sums plus a
// global distinct-interval count per bucket, kept in step with scada_values
// by both writers (src/ingest.ts, src/backfill.ts). The aggregate endpoint
// routes resolution 3600/86400 queries to these tables — see src/api.ts.
//
// Refresh model: RECOMPUTE, not increment. Both writers upsert raw rows (a
// re-ingest can overwrite an existing value), so delta arithmetic would
// drift; instead every bucket the written range touches is rebuilt whole
// from scada_values inside one D1 batch (= one transaction). That makes the
// refresh idempotent and self-healing: re-running it for any range always
// converges on the truth in scada_values.

/**
 * NEM market time is AEST (UTC+10, no DST). 36000 % res === 0 for every
 * sub-daily resolution, so the offset only shifts daily bucket boundaries
 * (to AEST midnight) — sub-daily buckets are unaffected by it.
 */
export const NEM_UTC_OFFSET_SECONDS = 36000;

const HOUR = 3600;
const DAY = 86400;

/**
 * Bucket label SQL: period-ENDING (AEMO SETTLEMENTDATE convention — a sample
 * ending exactly on a boundary belongs to the bucket ending there), aligned
 * to NEM time. `resolution` is always a server-side constant, never user
 * input.
 */
export function bucketExpr(column: string, resolution: number): string {
  return `((${column} + ${NEM_UTC_OFFSET_SECONDS + resolution - 1}) / ${resolution}) * ${resolution} - ${NEM_UTC_OFFSET_SECONDS}`;
}

/** JS twin of bucketExpr: the period-ending NEM-aligned bucket label for a time. */
export function nemBucket(unixSeconds: number, resolution: number): number {
  return Math.ceil((unixSeconds + NEM_UTC_OFFSET_SECONDS) / resolution) * resolution - NEM_UTC_OFFSET_SECONDS;
}

/**
 * Rebuild every rollup bucket touched by raw rows in [minTime, maxTime].
 * Call AFTER the scada_values upsert and BEFORE the scrape-ledger write:
 * ledger-last means a failed refresh leaves the file unrecorded and the next
 * run retries values + rollups together, so rollups can never go permanently
 * stale behind a ledgered file.
 *
 * A bucket's rows are selected by half-open range (label - width, label], so
 * binding (firstLabel - width, lastLabel] covers exactly the touched buckets,
 * whole. Daily rows derive from the hourly ones (a NEM day is exactly 24
 * NEM-aligned hours — no DST) so the expensive raw scan happens once.
 */
export async function refreshRollups(db: D1Database, minTime: number, maxTime: number): Promise<void> {
  const hourBinds = [nemBucket(minTime, HOUR) - HOUR, nemBucket(maxTime, HOUR)];
  const dayBinds = [nemBucket(minTime, DAY) - DAY, nemBucket(maxTime, DAY)];
  await db.batch([
    db
      .prepare(
        'INSERT INTO scada_hourly (bucket, generator_id, sum_value, n_samples) ' +
          `SELECT ${bucketExpr('scrape_time', HOUR)} AS hour_bucket, generator_id, SUM(value), COUNT(*) ` +
          'FROM scada_values WHERE scrape_time > ? AND scrape_time <= ? ' +
          'GROUP BY hour_bucket, generator_id ' +
          'ON CONFLICT(bucket, generator_id) DO UPDATE SET ' +
          'sum_value = excluded.sum_value, n_samples = excluded.n_samples',
      )
      .bind(...hourBinds),
    db
      .prepare(
        'INSERT INTO scada_intervals (bucket, n_intervals) ' +
          `SELECT ${bucketExpr('scrape_time', HOUR)} AS hour_bucket, COUNT(DISTINCT scrape_time) ` +
          'FROM scada_values WHERE scrape_time > ? AND scrape_time <= ? ' +
          'GROUP BY hour_bucket ' +
          'ON CONFLICT(bucket) DO UPDATE SET n_intervals = excluded.n_intervals',
      )
      .bind(...hourBinds),
    // Runs after the hourly statement in the same transaction, so it reads
    // the hourly rows just written.
    db
      .prepare(
        'INSERT INTO scada_daily (bucket, generator_id, sum_value, n_samples) ' +
          `SELECT ${bucketExpr('bucket', DAY)} AS day_bucket, generator_id, SUM(sum_value), SUM(n_samples) ` +
          'FROM scada_hourly WHERE bucket > ? AND bucket <= ? ' +
          'GROUP BY day_bucket, generator_id ' +
          'ON CONFLICT(bucket, generator_id) DO UPDATE SET ' +
          'sum_value = excluded.sum_value, n_samples = excluded.n_samples',
      )
      .bind(...dayBinds),
  ]).catch((err: unknown) => {
    // The rethrow is load-bearing: callers skip their ledger write on failure
    // so the file retries whole (values + rollups). Log the touched range
    // here so a tail trace names the failing refresh, not just the file.
    console.error(
      `rollups: refresh failed for buckets in hourly range (${hourBinds[0]}, ${hourBinds[1]}]:`,
      err instanceof Error ? err.message : err,
    );
    throw err;
  });
}
