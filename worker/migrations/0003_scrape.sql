-- Processed-file ledger for the SCADA ingest Worker (LAB-417), replacing the
-- legacy `scrape` table (which keyed on scrape_time; filename is the natural
-- key here because discovery works from the NEMWEB listing's filenames).
-- Filenames are PUBLIC_DISPATCHSCADA_<YYYYMMDDHHMM>_<seq>.zip — fixed prefix +
-- timestamp, so lexicographic order == chronological order. Ingest relies on
-- this to bound its "already seen?" lookup to the listing's window with a
-- single range query instead of scanning the whole ledger.
CREATE TABLE scrape (
    filename TEXT PRIMARY KEY,
    ingested_at INTEGER NOT NULL -- unix seconds when the ingest run recorded this file
) WITHOUT ROWID;
