-- CDEII emissions data (LAB-1698): AEMO's published per-generator emission
-- factors plus the official daily Carbon Dioxide Equivalent Intensity Index,
-- both from nemweb.com.au/Reports/Current/CDEII/ (attribution-only license,
-- same terms as the Dispatch SCADA ingest). Feeds /api/v2/intensity:
-- per-bucket regional intensity = SUM(MW x factor) / SUM(MW) over generation,
-- joined to scada rollups/raw values via generators.duid.

-- One row per (DUID, GENSETID) from CO2EII_AVAILABLE_GENERATORS.CSV (~630
-- rows, refreshed weekly upstream, re-fetched daily by the emissions cron).
-- A DUID can carry several genset rows; AEMO publishes identical factors
-- across a DUID's gensets today (verified 2026-08-08: 0 conflicting DUIDs),
-- so queries join through a per-DUID AVG(factor) — the refresh warns loudly
-- if that assumption ever breaks.
CREATE TABLE emission_factors (
    duid TEXT NOT NULL,
    genset_id TEXT NOT NULL,
    station_name TEXT,
    region TEXT,                 -- REGIONID as published; informational (queries use generators.state)
    factor REAL NOT NULL,        -- CO2E_EMISSIONS_FACTOR, tCO2-e/MWh sent-out
    energy_source TEXT,          -- CO2E_ENERGY_SOURCE
    data_source TEXT,            -- CO2E_DATA_SOURCE provenance (ISP2022/ISP2024/NGA ...)
    PRIMARY KEY (duid, genset_id)
) WITHOUT ROWID;

-- Official daily index rows from CO2EII_SUMMARY_RESULTS.CSV (NER 3.13.14):
-- 6 rows/day (NEM + 5 regions), published weekly covering the week's days.
-- `day` is the row's SETTLEMENTDATE — the AEST midnight STARTING the day —
-- stored as unix seconds; our period-ENDING daily bucket for the same day is
-- day + 86400. The file covers the contract year to date; upserts accumulate
-- across years. Kept for reconciliation (the honesty check on our computed
-- intensity), not served by the API yet.
CREATE TABLE cdeii_index (
    day INTEGER NOT NULL,        -- unix seconds, AEST midnight starting the day
    region TEXT NOT NULL,        -- 'NEM', 'QLD1', 'NSW1', 'VIC1', 'SA1', 'TAS1'
    total_energy REAL,           -- TOTAL_SENT_OUT_ENERGY, MWh
    total_emissions REAL,        -- TOTAL_EMISSIONS, tCO2-e
    intensity REAL NOT NULL,     -- CO2E_INTENSITY_INDEX, tCO2-e/MWh
    PRIMARY KEY (day, region)
) WITHOUT ROWID;
