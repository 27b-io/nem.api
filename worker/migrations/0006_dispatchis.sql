-- DispatchIS ingest (LAB-1700): regional 5-minute spot price + demand, and
-- interconnector flows, from NEMWEB DispatchIS_Reports (same feed family,
-- packaging and retention as Dispatch_SCADA). Row volume is tiny next to
-- scada_values: 5 regions + ~6 interconnectors per interval ≈ 3.2k rows/day,
-- so no rollup tables — 13 months of dispatch_region is ~570k rows and a
-- (bucket, region) GROUP BY over it stays far inside D1's memory budget
-- (the LAB-1696 SQLITE_NOMEM ceiling was hit grouping ~13M scada rows).
--
-- settlement_time = unix seconds of the period-ENDING SETTLEMENTDATE (NEM
-- market time, AEST +10, no DST), identical semantics to scada_values.
-- Only INTERVENTION=0 rows are ingested (intervention runs duplicate rows).

-- rrp comes from DISPATCH,PRICE and total_demand from DISPATCH,REGIONSUM —
-- two tables of the same file, merged onto one row per (interval, region).
-- Both are nullable so a file carrying one table but not the other still
-- ingests; the upsert COALESCEs per column so a partial row never nulls out
-- the other column on re-ingest.
CREATE TABLE dispatch_region (
    settlement_time INTEGER NOT NULL,
    region TEXT NOT NULL,           -- NEM region id: QLD1/NSW1/VIC1/SA1/TAS1
    rrp REAL,                       -- regional reference price, $/MWh (negative is a routine market state)
    total_demand REAL,              -- dispatch-run TOTALDEMAND, MW
    PRIMARY KEY (settlement_time, region)
) WITHOUT ROWID;

-- Stored for a later flow-map epic; not exposed via /api/v2 yet (LAB-1700
-- scope). metered_mw_flow is signed — negative means flow against the
-- interconnector's defined direction, a routine state.
CREATE TABLE dispatch_interconnector (
    settlement_time INTEGER NOT NULL,
    interconnector TEXT NOT NULL,   -- e.g. VIC1-NSW1, V-SA, N-Q-MNSP1
    metered_mw_flow REAL NOT NULL,  -- MW, from DISPATCH,INTERCONNECTORRES METEREDMWFLOW
    PRIMARY KEY (settlement_time, interconnector)
) WITHOUT ROWID;
