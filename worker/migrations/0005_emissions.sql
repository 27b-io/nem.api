-- Carbon-intensity inputs (LAB-1698), both from AEMO's CDEII report
-- (https://nemweb.com.au/Reports/Current/CDEII/, attribution-only licence —
-- the same terms as the Dispatch SCADA we already ingest). Refreshed daily by
-- the Worker cron (src/cdeii.ts); the files themselves republish weekly.
--
-- Deliberately NOT seeded here, unlike 0002_seed_generators.sql: a committed
-- seed would be a second copy of data that AEMO restates, and the refresh is
-- one cheap fetch away. Apply the migration, then trigger the refresh once
-- (recipe in worker/README.md) — until it runs, /api/v2/intensity honestly
-- reports zero coverage rather than a wrong number.

-- CO2EII_AVAILABLE_GENERATORS.CSV: AEMO's published emission factor per
-- dispatch unit. The file is one row per GENSETID, so a DUID with several
-- gensets repeats (43 of 573 do) — always with the SAME factor, which the
-- refresh asserts before writing. DUID is therefore the natural key, and it
-- joins generators.duid with zero name matching.
CREATE TABLE emission_factors (
    duid TEXT PRIMARY KEY,
    factor REAL NOT NULL    -- tCO2-e per MWh SENT OUT (not as-generated — see worker/API.md)
) WITHOUT ROWID;

-- CO2EII_SUMMARY_RESULTS.CSV: AEMO's OFFICIAL daily intensity index published
-- under NER 3.13.14 — six rows per day (NEM + the five regions). This is not
-- an input to our computed series; it is the reconciliation line that proves
-- the computed series honest, and it is republished alongside it.
--
-- settlement_date is stored exactly as AEMO publishes it: unix seconds of
-- AEST midnight at the START of the day the row describes. Our daily buckets
-- are period-ENDING, so the bucket covering this row is settlement_date +
-- 86400 — translated in one place (CDEII_DAY_SECONDS, src/api.ts) rather than
-- baked into storage, so the stored value stays auditable against the source.
--
-- Only `intensity` is read today; sent_out_energy and emissions are kept
-- anyway, and deliberately. The CURRENT file is a ROLLING ~7-month window, so
-- a day that rolls off before we captured its inputs is not re-derivable from
-- anywhere we ingest — unlike the factor table, which is current-state and
-- re-fetched daily. Two REAL columns on six rows a day is the cheapest
-- insurance in this schema. Do not "clean these up" as unused.
CREATE TABLE cdeii_daily (
    settlement_date INTEGER NOT NULL,
    region TEXT NOT NULL,           -- 'NEM' plus the five NEM region ids
    sent_out_energy REAL NOT NULL,  -- MWh
    emissions REAL NOT NULL,        -- tCO2-e
    intensity REAL NOT NULL,        -- tCO2-e/MWh == emissions / sent_out_energy
    PRIMARY KEY (settlement_date, region)
) WITHOUT ROWID;
