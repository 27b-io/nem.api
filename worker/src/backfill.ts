// ARCHIVE backfill (LAB-420): ingest the NEMWEB ARCHIVE's rolling ~13 months
// of daily Dispatch SCADA zips into D1 and R2. Each daily zip is a zip-of-zips
// (288 inner five-minute zips, same filename format as CURRENT); the inner
// CSVs go through the same parse/map/upsert path as the CURRENT ingest.
//
// Runs on its own cron (BACKFILL_CRON, offset from the 5-minute ingest so the
// two never share an invocation budget) and drains oldest-first at
// MAX_DAYS_PER_RUN per run — the full archive (~375 days) completes in roughly
// a day of wall time. Once drained, each run costs a listing fetch plus one
// ledger query, and picks up new daily zips as ARCHIVE publishes them — so
// gaps longer than CURRENT's ~2-day window heal automatically, forever.
//
// Resumability is per day: a daily zip's filename is recorded in the `scrape`
// ledger only after its values are upserted and the raw zip archived, so a
// failed day stays unrecorded and retries next run. Value upserts are
// idempotent, so re-processing a day that CURRENT ingest already covered (the
// ARCHIVE/CURRENT boundary overlaps by design) is a harmless no-op.
//
// Measured (LAB-420, live 2026-01-15 archive): daily zip ~1.2MB compressed,
// ~11.5MB of CSV decompressed one inner file at a time, ~60k mapped rows held
// at peak — well inside the 128MB isolate cap, so no Queues fan-out needed.

import { unzipSync } from 'fflate';
import type { Env } from './index';
import { extractZipFilenames, loadDuidMap, refreshTouchedRollups, upsertValues } from './ingest';
import { parseUnitScadaCsv } from './scada';

export const ARCHIVE_LISTING_URL = 'https://nemweb.com.au/Reports/ARCHIVE/Dispatch_SCADA/';

// Must match the second cron expression in wrangler.toml exactly — the
// scheduled handler dispatches on controller.cron string equality. Offset
// minutes so it never coincides with the */5 CURRENT ingest.
export const BACKFILL_CRON = '11,26,41,56 * * * *';

// Daily archive names: PUBLIC_DISPATCHSCADA_<YYYYMMDD>.zip (the inner
// five-minute files carry a 12-digit timestamp plus sequence suffix, so the
// two never collide in the ledger). GLOB uses ? = exactly one character.
const DAILY_NAME = /^PUBLIC_DISPATCHSCADA_\d{8}\.zip$/;
const DAILY_NAME_GLOB = 'PUBLIC_DISPATCHSCADA_????????.zip';

// ponytail: 4 days/run keeps a run at ~4-8s CPU (default 30s isolate budget)
// and ~90 subrequests; drains ~375 days in ~24h at the 15-min cadence. Bump if
// the backfill needs to land faster — memory is nowhere near the ceiling.
const MAX_DAYS_PER_RUN = 4;

// Same WAF posture as the CURRENT ingest: consecutive fetch failures usually
// mean NEMWEB is rate-limiting us — stop extending the block, resume next run.
const MAX_CONSECUTIVE_FAILURES = 3;

// upsertValues emits one 32-row statement per chunk; 8192 rows = 256
// statements per D1 batch call, comfortably under request-size and
// transaction-duration limits while keeping subrequests to ~8 per day.
const UPSERT_ROWS_PER_BATCH = 8192;

// A complete NEM day is 288 five-minute dispatch intervals (market time never
// observes daylight saving, so there are no 276/300-interval days).
const INTERVALS_PER_DAY = 288;

export interface DayStats {
  innerFiles: number;
  skippedInner: number;
  values: number;
  intervals: number;
  unknownDuids: string[];
  source: 'r2' | 'nemweb';
}

/** Daily-archive filenames already recorded in the ledger, within the listing's range. */
async function ledgeredDailies(db: D1Database, filenames: string[]): Promise<Set<string>> {
  if (filenames.length === 0) return new Set();
  const sorted = [...filenames].sort();
  // Range on the PK bounds the scan; the GLOB drops the five-minute filenames
  // that interleave lexicographically within the same date range.
  const { results } = await db
    .prepare('SELECT filename FROM scrape WHERE filename >= ? AND filename <= ? AND filename GLOB ?')
    .bind(sorted[0], sorted[sorted.length - 1], DAILY_NAME_GLOB)
    .all<{ filename: string }>();
  return new Set(results.map((r) => r.filename));
}

/**
 * Ingest one daily archive zip. Reads the raw zip from R2 when a prior
 * partial run already archived it (retries then skip the ~1.2MB NEMWEB
 * re-download — the ARCHIVE files are immutable, and the object is only ever
 * written after a successful full parse, so R2 content is always valid);
 * otherwise fetches from NEMWEB and archives after parsing.
 *
 * Inner five-minute entries that fail to unzip or parse are counted and
 * skipped, not thrown: a defect inside an immutable historical archive would
 * otherwise retry forever. Whole-day failures (fetch, corrupt outer zip, zero
 * parsed rows) do throw, leaving the day unledgered for retry.
 */
export async function ingestDaily(env: Env, filename: string, duids: Map<string, number>): Promise<DayStats> {
  const key = `archive/${filename}`;

  let zipBytes: Uint8Array;
  let source: DayStats['source'];
  const cached = await env.ARCHIVE.get(key);
  if (cached !== null) {
    zipBytes = new Uint8Array(await cached.arrayBuffer());
    source = 'r2';
  } else {
    const res = await fetch(new URL(filename, ARCHIVE_LISTING_URL));
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${filename}`);
    zipBytes = new Uint8Array(await res.arrayBuffer());
    source = 'nemweb';
  }

  const inner = unzipSync(zipBytes);
  const innerNames = Object.keys(inner)
    .filter((n) => /\.zip$/i.test(n))
    .sort();
  if (innerNames.length === 0) throw new Error(`${filename}: daily zip contains no inner zips`);

  let parsed = 0;
  let skippedInner = 0;
  const unknown = new Set<string>();
  const intervals = new Set<number>();
  const mapped: { scrapeTime: number; generatorId: number; value: number }[] = [];
  const decoder = new TextDecoder();

  for (const name of innerNames) {
    try {
      const entries = unzipSync(inner[name]);
      const csvName = Object.keys(entries).find((n) => /\.csv$/i.test(n));
      if (!csvName) throw new Error('no CSV entry');
      const { rows, malformed } = parseUnitScadaCsv(decoder.decode(entries[csvName]));
      if (malformed > 0) console.warn(`backfill: ${filename}/${name}: skipped ${malformed} malformed row(s)`);
      if (rows.length === 0) throw new Error('no D,DISPATCH,UNIT_SCADA rows');
      parsed += rows.length;
      for (const row of rows) {
        intervals.add(row.scrapeTime);
        const generatorId = duids.get(row.duid);
        if (generatorId === undefined) {
          unknown.add(row.duid);
          continue;
        }
        mapped.push({ scrapeTime: row.scrapeTime, generatorId, value: row.value });
      }
    } catch (err) {
      // The archive is immutable — this inner file will never heal on retry.
      // Log the gap and move on; the raw daily zip lands in R2 regardless.
      skippedInner++;
      console.warn(`backfill: ${filename}/${name}: skipped inner file:`, err instanceof Error ? err.message : err);
    }
  }

  if (parsed === 0) {
    // Every inner file empty of UNIT_SCADA rows means format drift or a
    // garbage download, not a data quirk — fail the day loudly and retry.
    throw new Error(`${filename}: no UNIT_SCADA rows in any inner file`);
  }

  // Archive before the upserts (unlike the CURRENT ingest, which archives
  // after): the full parse above already validated the bytes, and archiving
  // first means an upsert failure retries from R2 instead of re-downloading
  // 1.2MB from a rate-limited host.
  if (source === 'nemweb') {
    await env.ARCHIVE.put(key, zipBytes);
  }

  for (let i = 0; i < mapped.length; i += UPSERT_ROWS_PER_BATCH) {
    await upsertValues(env.DB, mapped.slice(i, i + UPSERT_ROWS_PER_BATCH));
  }
  await refreshTouchedRollups(env.DB, mapped); // pre-ledger, per the refreshRollups contract

  // Ledger write last, same contract as the CURRENT ingest: any failure above
  // leaves the day unrecorded and the next run retries it end to end.
  await env.DB.prepare('INSERT OR IGNORE INTO scrape (filename, ingested_at) VALUES (?, ?)')
    .bind(filename, Math.floor(Date.now() / 1000))
    .run();

  return {
    innerFiles: innerNames.length,
    skippedInner,
    values: mapped.length,
    intervals: intervals.size,
    unknownDuids: [...unknown],
    source,
  };
}

export interface BackfillRun {
  ok: number;
  failed: number;
  values: number;
  /** Pending daily archives left for future runs after this one. */
  remaining: number;
}

export async function runBackfill(env: Env, listingUrl: string = ARCHIVE_LISTING_URL): Promise<BackfillRun> {
  const listing = await fetch(listingUrl);
  if (!listing.ok) throw new Error(`HTTP ${listing.status} fetching listing ${listingUrl}`);
  const dailies = (await extractZipFilenames(listing)).filter((n) => DAILY_NAME.test(n));

  const seen = await ledgeredDailies(env.DB, dailies);
  const pending = dailies.filter((f) => !seen.has(f)); // sorted → oldest first
  if (pending.length === 0) {
    console.log(`backfill: idle (${dailies.length} daily archives listed, all ingested)`);
    return { ok: 0, failed: 0, values: 0, remaining: 0 };
  }

  const batch = pending.slice(0, MAX_DAYS_PER_RUN);
  const duids = await loadDuidMap(env.DB);
  const unknown = new Set<string>();
  let ok = 0;
  let failed = 0;
  let values = 0;
  let consecutiveFailures = 0;

  for (const filename of batch) {
    try {
      const stats = await ingestDaily(env, filename, duids);
      ok++;
      values += stats.values;
      consecutiveFailures = 0;
      for (const duid of stats.unknownDuids) unknown.add(duid);

      // Per-day sanity band (acceptance criterion): a complete day is 288
      // inner files resolving to 288 distinct intervals. Deviations are gaps —
      // logged here, permanently visible in the run history.
      const gaps: string[] = [];
      if (stats.innerFiles !== INTERVALS_PER_DAY) gaps.push(`${stats.innerFiles}/${INTERVALS_PER_DAY} inner files`);
      if (stats.skippedInner > 0) gaps.push(`${stats.skippedInner} inner file(s) skipped`);
      if (stats.intervals !== stats.innerFiles - stats.skippedInner) {
        gaps.push(`${stats.intervals} distinct interval(s)`);
      }
      const summary = `backfill: ${filename}: ${stats.innerFiles} file(s), ${stats.intervals} interval(s), ${stats.values} value(s), source=${stats.source}`;
      if (gaps.length > 0) console.warn(`${summary} — GAPS: ${gaps.join('; ')}`);
      else console.log(summary);
    } catch (err) {
      // Per-day isolation: the day never reached the ledger, so it retries
      // next run; later days still get their chance this run.
      failed++;
      consecutiveFailures++;
      console.error(`backfill: ${filename} failed:`, err instanceof Error ? err.message : err);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(
          `backfill: aborting run after ${consecutiveFailures} consecutive failures ` +
            '(NEMWEB rate limit?); next run retries from here',
        );
        break;
      }
    }
  }

  if (unknown.size > 0) {
    // Same registration drift the CURRENT ingest logs — values for DUIDs
    // missing from `generators` are dropped, recoverable from the R2 archive
    // once the LAB-421 registration refresh lands (see worker/README.md).
    console.warn(`backfill: ${unknown.size} unknown DUID(s), values dropped: ${[...unknown].sort().join(', ')}`);
  }
  const remaining = pending.length - ok - failed;
  console.log(
    `backfill: ${ok}/${batch.length} daily archive(s) ingested (${values} values), ${failed} failed, ` +
      `${remaining} remaining`,
  );
  return { ok, failed, values, remaining };
}
