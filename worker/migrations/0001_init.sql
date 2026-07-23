-- Ported from legacy api/db/schema.sql.
-- Legacy normalized tables (participant/technology/fuel/generator) are dropped:
-- the API only ever queried the flattened view, so `generators` == legacy `flat_generators`.

-- One row per (name, duid) generator, capacities summed across physical unit rows.
CREATE TABLE generators (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    participant_name TEXT NOT NULL,
    duid TEXT NOT NULL, -- '-' when the unit has no market DUID (non-market units)
    state TEXT NOT NULL,
    technology_type TEXT,
    technology_description TEXT,
    fuel_type TEXT,
    fuel_description TEXT,
    reg_cap REAL,
    max_cap REAL
);

-- Same (duid, name) uniqueness the legacy `generator` table enforced; makes re-seeding idempotent.
CREATE UNIQUE INDEX generators_duid_name ON generators (duid, name);
CREATE INDEX generators_idx_state ON generators (state);
CREATE INDEX generators_idx_tech ON generators (technology_type, technology_description);
CREATE INDEX generators_idx_fuel ON generators (fuel_type, fuel_description);

-- scrape_time = unix seconds (UTC) of the dispatch interval.
-- PK (scrape_time, generator_id) preserved from legacy so ingest upserts stay idempotent.
-- generator_id references generators.id but is intentionally NOT an FK: the registration
-- refresh (LAB-421) replaces generators wholesale and must not be blocked by value rows.
-- No separate index on scrape_time — it is the leftmost PK column, so time-range scans
-- already use the primary key of this clustered (WITHOUT ROWID) table.
CREATE TABLE scada_values (
    scrape_time INTEGER NOT NULL,
    generator_id INTEGER NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (scrape_time, generator_id)
) WITHOUT ROWID;
