// ARCHIVE backfill (LAB-420 SCADA, LAB-1700 DispatchIS, LAB-1701 rooftop PV):
// ingest a NEMWEB ARCHIVE's rolling window of bundle zips into D1 and R2.
// Each bundle is a zip-of-zips (daily × 288 inner five-minute zips for the
// dispatch feeds; weekly × 336 inner half-hour zips for ROOFTOP_PV — same
// two-level packaging, just a bigger "day"); the inner CSVs go through the
// same Feed parse/store path as the CURRENT ingest (src/ingest.ts).
//
// Runs on its own cron (BACKFILL_CRON, offset from the 5-minute ingest so the
// two never share an invocation budget) and drains oldest-first at
// MAX_BUNDLES_PER_RUN per run — a full archive (~375 days) completes in roughly
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
// Measured (LAB-420, live 2026-01-15 archive): SCADA daily zip ~1.2MB
// compressed, ~11.5MB of CSV decompressed one inner file at a time, ~60k
// mapped rows held at peak — well inside the 128MB isolate cap, so no Queues
// fan-out needed. DispatchIS dailies are far smaller (~3.2k stored rows/day).

import { unzipSync } from 'fflate';
import type { Feed, FeedProcessor } from './ingest';
import { extractZipFilenames, fetchNemweb } from './ingest';
import type { Env } from './index';

// Must match the second cron expression in wrangler.toml exactly — the
// scheduled handler dispatches on controller.cron string equality. Offset
// minutes so it never coincides with the */5 CURRENT ingest.
export const BACKFILL_CRON = '11,26,41,56 * * * *';

// ponytail: 4 days/run keeps a SCADA run at ~4-8s CPU (default 30s isolate
// budget) and ~90 subrequests; drains ~375 days in ~24h at the 15-min
// cadence. Bump if a backfill needs to land faster — memory is nowhere near
// the ceiling.
const MAX_BUNDLES_PER_RUN = 4;

// Same WAF posture as the CURRENT ingest: consecutive fetch failures usually
// mean NEMWEB is rate-limiting us — stop extending the block, resume next run.
const MAX_CONSECUTIVE_FAILURES = 3;

export interface DayStats {
  innerFiles: number;
  skippedInner: number;
  values: number;
  intervals: number;
  source: 'r2' | 'nemweb';
}

/** Daily-archive filenames already recorded in the ledger, within the listing's range. */
async function ledgeredDailies(db: D1Database, filenames: string[], glob: string): Promise<Set<string>> {
  if (filenames.length === 0) return new Set();
  const sorted = [...filenames].sort();
  // Range on the PK bounds the scan; the GLOB drops the five-minute filenames
  // that interleave lexicographically within the same date range.
  const { results } = await db
    .prepare('SELECT filename FROM scrape WHERE filename >= ? AND filename <= ? AND filename GLOB ?')
    .bind(sorted[0], sorted[sorted.length - 1], glob)
    .all<{ filename: string }>();
  return new Set(results.map((r) => r.filename));
}

/**
 * Ingest one daily archive zip. Reads the raw zip from R2 when a prior
 * partial run already archived it (retries then skip the NEMWEB re-download —
 * the ARCHIVE files are immutable, and the object is only ever written after
 * a successful full parse, so R2 content is always valid); otherwise fetches
 * from NEMWEB and archives after parsing.
 *
 * Inner five-minute entries that fail to unzip or parse are counted and
 * skipped, not thrown: a defect inside an immutable historical archive would
 * otherwise retry forever. Whole-day failures (fetch, corrupt outer zip, zero
 * parsed rows) do throw, leaving the day unledgered for retry.
 */
export async function ingestDaily<B>(
  env: Env,
  feed: Feed<B>,
  processor: FeedProcessor<B>,
  filename: string,
): Promise<DayStats> {
  const tag = `backfill:${feed.label}`;
  const key = `archive/${filename}`;

  let zipBytes: Uint8Array;
  let source: DayStats['source'];
  const cached = await env.ARCHIVE.get(key);
  if (cached !== null) {
    zipBytes = new Uint8Array(await cached.arrayBuffer());
    source = 'r2';
  } else {
    const res = await fetchNemweb(new URL(filename, feed.archiveListingUrl));
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
  const intervals = new Set<number>();
  const batches: B[] = [];
  const decoder = new TextDecoder();

  for (const name of innerNames) {
    try {
      const entries = unzipSync(inner[name]);
      const csvName = Object.keys(entries).find((n) => /\.csv$/i.test(n));
      if (!csvName) throw new Error('no CSV entry');
      const result = processor.parse(decoder.decode(entries[csvName]), `${tag}: ${filename}/${name}`);
      parsed += result.rows;
      batches.push(result.batch);
      for (const t of result.intervals) intervals.add(t);
    } catch (err) {
      // The archive is immutable — this inner file will never heal on retry.
      // Log the gap and move on; the raw daily zip lands in R2 regardless.
      skippedInner++;
      console.warn(`${tag}: ${filename}/${name}: skipped inner file:`, err instanceof Error ? err.message : err);
    }
  }

  if (parsed === 0) {
    // Every inner file empty of usable rows means format drift or a garbage
    // download, not a data quirk — fail the day loudly and retry.
    throw new Error(`${filename}: no usable rows in any inner file`);
  }

  // Archive before the upserts (unlike the CURRENT ingest, which archives
  // after): the full parse above already validated the bytes, and archiving
  // first means an upsert failure retries from R2 instead of re-downloading
  // from a rate-limited host.
  if (source === 'nemweb') {
    await env.ARCHIVE.put(key, zipBytes);
  }

  const values = await processor.store(batches);

  // Ledger write last, same contract as the CURRENT ingest: any failure above
  // leaves the day unrecorded and the next run retries it end to end.
  await env.DB.prepare('INSERT OR IGNORE INTO scrape (filename, ingested_at) VALUES (?, ?)')
    .bind(filename, Math.floor(Date.now() / 1000))
    .run();

  return {
    innerFiles: innerNames.length,
    skippedInner,
    values,
    intervals: intervals.size,
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

export async function runBackfill<B>(env: Env, feed: Feed<B>): Promise<BackfillRun> {
  const tag = `backfill:${feed.label}`;
  const listing = await fetchNemweb(feed.archiveListingUrl);
  if (!listing.ok) throw new Error(`HTTP ${listing.status} fetching listing ${feed.archiveListingUrl}`);
  const bundles = (await extractZipFilenames(listing)).filter((n) => feed.archiveNameRe.test(n));

  const seen = await ledgeredDailies(env.DB, bundles, feed.archiveNameGlob);
  const pending = bundles.filter((f) => !seen.has(f)); // sorted → oldest first
  if (pending.length === 0) {
    console.log(`${tag}: idle (${bundles.length} archive bundles listed, all ingested)`);
    return { ok: 0, failed: 0, values: 0, remaining: 0 };
  }

  const batch = pending.slice(0, MAX_BUNDLES_PER_RUN);
  const processor = await feed.createProcessor(env);
  let ok = 0;
  let failed = 0;
  let values = 0;
  let consecutiveFailures = 0;

  for (const filename of batch) {
    try {
      const stats = await ingestDaily(env, feed, processor, filename);
      ok++;
      values += stats.values;
      consecutiveFailures = 0;

      // Per-bundle sanity band (acceptance criterion): a complete bundle is
      // feed.archiveInnerFiles inner files (288 for the daily 5-min feeds, 336
      // for ROOFTOP_PV's weekly bundles) resolving to as many distinct
      // intervals. Deviations are gaps — logged here, permanently visible in
      // the run history.
      const gaps: string[] = [];
      if (stats.innerFiles !== feed.archiveInnerFiles) {
        gaps.push(`${stats.innerFiles}/${feed.archiveInnerFiles} inner files`);
      }
      if (stats.skippedInner > 0) gaps.push(`${stats.skippedInner} inner file(s) skipped`);
      if (stats.intervals !== stats.innerFiles - stats.skippedInner) {
        gaps.push(`${stats.intervals} distinct interval(s)`);
      }
      const summary = `${tag}: ${filename}: ${stats.innerFiles} file(s), ${stats.intervals} interval(s), ${stats.values} value(s), source=${stats.source}`;
      if (gaps.length > 0) console.warn(`${summary} — GAPS: ${gaps.join('; ')}`);
      else console.log(summary);
    } catch (err) {
      // Per-day isolation: the day never reached the ledger, so it retries
      // next run; later days still get their chance this run.
      failed++;
      consecutiveFailures++;
      console.error(`${tag}: ${filename} failed:`, err instanceof Error ? err.message : err);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(
          `${tag}: aborting run after ${consecutiveFailures} consecutive failures ` +
            '(NEMWEB rate limit?); next run retries from here',
        );
        break;
      }
    }
  }

  processor.finish();
  const remaining = pending.length - ok - failed;
  console.log(
    `${tag}: ${ok}/${batch.length} archive bundle(s) ingested (${values} values), ${failed} failed, ` +
      `${remaining} remaining`,
  );
  return { ok, failed, values, remaining };
}
