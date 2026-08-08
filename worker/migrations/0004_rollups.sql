-- Pre-aggregated rollups (LAB-1696). The aggregate endpoint used to GROUP BY
-- raw 5-minute scada_values at query time; beyond ~90 days the (interval,
-- group) grouping exhausts SQLite's memory budget (observed live via wrangler
-- tail: D1_ERROR: out of memory: SQLITE_NOMEM). These tables hold
-- per-generator sums at hourly and daily grain so resolution 3600/86400
-- aggregates scan ~200k rollup rows for the full 13-month window instead of
-- ~50M raw rows. Per-GENERATOR (not per-fuel/region) so every generator
-- filter in the public contract still applies via the generators join.
--
-- Bucket labels are period-ENDING and NEM-aligned, identical to the API's
-- bucket labels (bucketExpr in src/rollups.ts): hourly labels are exact hour
-- ends, daily labels end at AEST midnight. Maintained incrementally by both
-- ingest paths (src/rollups.ts refreshRollups, called BEFORE the scrape
-- ledger write so a failed refresh retries with its file) and rebuilt on
-- demand from scada_values (one-off backfill recipe in worker/README.md).

CREATE TABLE scada_hourly (
    bucket INTEGER NOT NULL,        -- period-ending hourly label, unix seconds
    generator_id INTEGER NOT NULL,  -- references generators.id (not an FK, same as scada_values)
    sum_value REAL NOT NULL,        -- SUM(value) over the bucket's samples (net MW sums through)
    n_samples INTEGER NOT NULL,     -- COUNT(*) of samples behind sum_value
    PRIMARY KEY (bucket, generator_id)
) WITHOUT ROWID;

CREATE TABLE scada_daily (
    bucket INTEGER NOT NULL,        -- period-ending daily label (AEST midnight), unix seconds
    generator_id INTEGER NOT NULL,
    sum_value REAL NOT NULL,
    n_samples INTEGER NOT NULL,
    PRIMARY KEY (bucket, generator_id)
) WITHOUT ROWID;

-- Global distinct-interval count per hourly bucket: the denominator for the
-- aggregate's mean (daily buckets sum their hourly counts). Global rather
-- than per-group because group membership is decided at query time by
-- arbitrary filters; see the semantics note in src/api.ts.
CREATE TABLE scada_intervals (
    bucket INTEGER NOT NULL,        -- period-ending hourly label, unix seconds
    n_intervals INTEGER NOT NULL,   -- COUNT(DISTINCT scrape_time) in the bucket
    PRIMARY KEY (bucket)
) WITHOUT ROWID;
