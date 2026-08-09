-- Rooftop PV actuals ingest (LAB-1701): AEMO's per-region estimate of
-- distributed rooftop solar generation, from NEMWEB ROOFTOP_PV/ACTUAL
-- (MEASUREMENT type only — SATELLITE is an alternative estimate, out of
-- scope). 30-minute cadence, 5 regions ≈ 240 rows/day, so no rollup tables:
-- 13 months is ~90k rows and any GROUP BY over it is trivial next to the
-- scada_values ceilings.
--
-- interval_time = unix seconds of the period-ENDING INTERVAL_DATETIME (NEM
-- market time, AEST +10, no DST), same semantics as scada_values.scrape_time
-- and dispatch_region.settlement_time. power is an AEMO ESTIMATE published
-- ~30 minutes after the interval closes — not SCADA telemetry; the API and
-- dashboard must present it as such (and as absent, not zero, at the live
-- edge where SCADA already has data but this feed does not yet).
CREATE TABLE rooftop_pv (
    interval_time INTEGER NOT NULL,
    region TEXT NOT NULL,           -- NEM region id: QLD1/NSW1/VIC1/SA1/TAS1
    power REAL NOT NULL,            -- MW, AEMO estimate of rooftop PV generation
    quality REAL,                   -- AEMO QI 0..1 (estimate confidence), null when omitted
    PRIMARY KEY (interval_time, region)
) WITHOUT ROWID;
