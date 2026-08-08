// CURRENT ingest (LAB-417 SCADA, LAB-1700 DispatchIS): discover new zips on a
// NEMWEB autoindex, unzip in-Worker (fflate — Workers have DecompressionStream
// but no ZIP container support), parse the MMS CSV, upsert to D1, archive the
// raw zip to R2, and record the filename in the `scrape` ledger.
//
// Both feeds ship identical packaging (5-minute PUBLIC_*.zip of one CSV on
// CURRENT, daily zips-of-288 on ARCHIVE), so the fetch→unzip→parse→store→
// archive→ledger shell is shared and each feed plugs in a Feed definition:
// its URLs, daily-bundle name shape, and a per-run FeedProcessor that owns
// the feed's parse + upsert. src/backfill.ts drives the same Feed objects
// against the ARCHIVE listings.
//
// Idempotency: value tables upsert on their natural PKs, the R2 key is
// deterministic and skipped when present, and the ledger insert is OR IGNORE
// — so re-runs, overlapping crons, and partial-failure retries never
// double-insert. A file is only recorded in the ledger after everything else
// succeeded; any earlier failure leaves it unrecorded and the next run
// retries it. The two feeds share the `scrape` ledger — filename prefixes
// (PUBLIC_DISPATCHSCADA_ / PUBLIC_DISPATCHIS_) never collide.
//
// Gap handling: discovery diffs the full CURRENT listing (~2 days of files)
// against the ledger, oldest-first, so missed cron intervals are caught up
// automatically on the next run. MAX_FILES_PER_RUN bounds a single run's
// wall time; anything deferred is picked up 5 minutes later.

import { unzipSync } from 'fflate';
import { parseDispatchIsCsv, type DispatchIsBatch } from './dispatchis';
import type { Env } from './index';
import { refreshRollups } from './rollups';
import { parseUnitScadaCsv } from './scada';

// ponytail: fixed cap, oldest-first — a cold start over the full CURRENT
// listing (~580 files) drains in a dozen 5-minute runs. If a plan-level
// subrequest ceiling bites before the cap, per-file isolation still records
// every completed file, so the run makes forward progress either way.
const MAX_FILES_PER_RUN = 50;

// NEMWEB's WAF (Azure Front Door) rate-limits aggressive clients with 403s —
// observed live at roughly 100+ downloads inside a couple of minutes. Once
// failures run consecutively the clamp is on us: abort the run instead of
// extending the block, and let the next 5-minute run resume where we stopped.
const MAX_CONSECUTIVE_FAILURES = 5;

// D1 allows 100 bound parameters per statement.
const SCADA_CHUNK_ROWS = 32; // 3 binds per scada_values row
const REGION_CHUNK_ROWS = 25; // 4 binds per dispatch_region row
const INTERCONNECTOR_CHUNK_ROWS = 32; // 3 binds per dispatch_interconnector row

// upsertValues emits one 32-row statement per chunk; 8192 rows = 256
// statements per D1 batch call, comfortably under request-size and
// transaction-duration limits. Only the ARCHIVE backfill's day-sized arrays
// (~60k scada rows) ever span multiple batches.
const UPSERT_ROWS_PER_BATCH = 8192;

// ---------------------------------------------------------------------------
// Feed abstraction

/**
 * Per-run parse/store hooks for one feed. Created once per ingest or backfill
 * run (so per-run state like the DUID map is loaded once), then driven by the
 * shared shell: parse() per five-minute CSV, store() per CURRENT file or per
 * ARCHIVE day, finish() once at run end for aggregate logging.
 */
export interface FeedProcessor<Batch> {
  /**
   * Parse one five-minute CSV. Throws when the file carries no usable rows —
   * that means format drift or a garbage download, and failing loud keeps the
   * file unledgered for retry. Malformed-row counts are logged here.
   * `intervals` are the distinct settlement times seen (backfill gap stats).
   */
  parse(csv: string, context: string): { batch: Batch; rows: number; intervals: Set<number> };
  /** Idempotent chunked upsert of parsed batches; returns rows stored. */
  store(batches: Batch[]): Promise<number>;
  /** End-of-run aggregate logging (e.g. unknown DUIDs). */
  finish(): void;
}

export interface Feed<Batch> {
  /** Log/error tag: messages read `ingest:<label>: …` / `backfill:<label>: …`. */
  label: string;
  currentListingUrl: string;
  archiveListingUrl: string;
  /** Daily ARCHIVE bundle name shape (see src/backfill.ts). GLOB ? = exactly one character. */
  dailyNameRe: RegExp;
  dailyNameGlob: string;
  createProcessor(env: Env): Promise<FeedProcessor<Batch>>;
}

// ---------------------------------------------------------------------------
// Shared discovery helpers

// NEMWEB occasionally stalls mid-response instead of failing fast; without a
// deadline a hung fetch eats the rest of the invocation's wall-clock budget.
// 120s bounds a hard hang while leaving headroom for the largest object we
// pull (~6MB DispatchIS daily zip) over a degraded link — a too-tight
// deadline would deterministically abort the same fetch every retry.
const NEMWEB_FETCH_TIMEOUT_MS = 120_000;

/**
 * All NEMWEB calls go through here: fetch with a hard deadline. The signal
 * stays attached to the response body, so a stall during arrayBuffer() reads
 * aborts too, not just a stall before headers.
 *
 * Transport errors (incl. the deadline's bare "operation was aborted"
 * DOMException, which names neither URL nor cause) are mapped here — the one
 * choke point — to an Error carrying the URL, so every catch layer up the
 * stack (per-file, per-day, per-feed) logs an actionable message. A body-read
 * stall aborts at the caller's arrayBuffer() instead and surfaces unmapped —
 * there the per-file/per-day catch supplies the filename context. Callers
 * deliberately do NOT catch: throwing to those layers is the designed
 * ledger-write-last retry contract.
 */
export async function fetchNemweb(url: URL | string): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(NEMWEB_FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(
      `NEMWEB fetch failed (${url}): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Pull PUBLIC_*.zip filenames out of a NEMWEB autoindex page. The IIS-style
 * listing uses uppercase tags/attributes (<A HREF="...">) — HTMLRewriter
 * normalizes those. Returned sorted ascending, i.e. chronologically.
 */
export async function extractZipFilenames(listing: Response): Promise<string[]> {
  const names = new Set<string>();
  const rewriter = new HTMLRewriter().on('a[href]', {
    element(el) {
      const href = el.getAttribute('href');
      if (!href || !/\.zip$/i.test(href)) return;
      names.add(href.slice(href.lastIndexOf('/') + 1));
    },
  });
  // Handlers only fire while the transformed body is consumed.
  await rewriter.transform(listing).arrayBuffer();
  return [...names].sort();
}

async function alreadyIngested(db: D1Database, filenames: string[]): Promise<Set<string>> {
  if (filenames.length === 0) return new Set();
  // Filenames sort chronologically (fixed prefix + timestamp), so one range
  // query bounds the ledger scan to the listing's window however large the
  // ledger grows. Both bounds matter now that two feeds share the ledger:
  // every PUBLIC_DISPATCHIS_* name sorts below every PUBLIC_DISPATCHSCADA_*
  // name, so a lower bound alone would make the DispatchIS ingest sweep the
  // entire (never-pruned) SCADA ledger on every 5-minute run.
  const sorted = [...filenames].sort();
  const { results } = await db
    .prepare('SELECT filename FROM scrape WHERE filename >= ? AND filename <= ?')
    .bind(sorted[0], sorted[sorted.length - 1])
    .all<{ filename: string }>();
  return new Set(results.map((r) => r.filename));
}

// ---------------------------------------------------------------------------
// SCADA feed

interface MappedRow {
  scrapeTime: number;
  generatorId: number;
  value: number;
}

/**
 * DUID → generators.id. One DUID can map to several generator rows (Murray 1
 * and Murray 2 both report as MURRAY), so the SCADA value is attributed to the
 * lowest id — deterministic, same class of call the legacy scraper made.
 * '-' marks non-market units that never appear in SCADA.
 */
export async function loadDuidMap(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db
    .prepare("SELECT duid, MIN(id) AS id FROM generators WHERE duid != '-' GROUP BY duid")
    .all<{ duid: string; id: number }>();
  return new Map(results.map((r) => [r.duid, r.id]));
}

/**
 * Refresh the rollup buckets (LAB-1696) covering a batch of upserted rows.
 * Called by the SCADA processor after its value upsert and before the ledger
 * write — the ordering contract lives on refreshRollups (src/rollups.ts).
 *
 * Cache visibility of the upsert→refresh gap (rollup readers see the new
 * rows only after this completes): relative windows are never closed-cached
 * (nowDerived ⇒ boundary TTL), and explicit rollup-resolution windows only
 * count as closed once their FULL edge bucket has ended plus
 * INGEST_GRACE_SECONDS (src/cache.ts) — by then this refresh, which runs
 * seconds after the boundary inside the same ingest run, has completed. An
 * ingest running longer than the grace (backlogged catch-up run) can
 * closed-cache a stale response either way: pre-upsert both paths miss the
 * final sample; in the upsert→refresh sliver the rollup edge bucket runs one
 * sample behind raw. Both are the same accepted slow-ingest residual,
 * bounded by CLOSED_WINDOW_TTL_SECONDS — not fixable by reordering, since
 * rollups are computed FROM the upserted rows.
 */
export async function refreshTouchedRollups(db: D1Database, rows: MappedRow[]): Promise<void> {
  if (rows.length === 0) return;
  let minTime = rows[0].scrapeTime;
  let maxTime = minTime;
  for (const row of rows) {
    if (row.scrapeTime < minTime) minTime = row.scrapeTime;
    if (row.scrapeTime > maxTime) maxTime = row.scrapeTime;
  }
  await refreshRollups(db, minTime, maxTime);
}

/** Idempotent chunked upsert; one D1 batch (= one transaction) per call. */
export async function upsertValues(db: D1Database, rows: MappedRow[]): Promise<void> {
  if (rows.length === 0) return;
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += SCADA_CHUNK_ROWS) {
    const chunk = rows.slice(i, i + SCADA_CHUNK_ROWS);
    const sql =
      'INSERT INTO scada_values (scrape_time, generator_id, value) VALUES ' +
      chunk.map(() => '(?,?,?)').join(',') +
      ' ON CONFLICT(scrape_time, generator_id) DO UPDATE SET value = excluded.value';
    statements.push(db.prepare(sql).bind(...chunk.flatMap((r) => [r.scrapeTime, r.generatorId, r.value])));
  }
  await db.batch(statements);
}

export const SCADA_FEED: Feed<MappedRow[]> = {
  label: 'scada',
  currentListingUrl: 'https://nemweb.com.au/Reports/CURRENT/Dispatch_SCADA/',
  archiveListingUrl: 'https://nemweb.com.au/Reports/ARCHIVE/Dispatch_SCADA/',
  // Daily archive names: PUBLIC_DISPATCHSCADA_<YYYYMMDD>.zip (the inner
  // five-minute files carry a 12-digit timestamp plus sequence suffix, so the
  // two never collide in the ledger).
  dailyNameRe: /^PUBLIC_DISPATCHSCADA_\d{8}\.zip$/,
  dailyNameGlob: 'PUBLIC_DISPATCHSCADA_????????.zip',
  async createProcessor(env: Env): Promise<FeedProcessor<MappedRow[]>> {
    const duids = await loadDuidMap(env.DB);
    const unknown = new Set<string>();
    return {
      parse(csv, context) {
        const { rows, malformed } = parseUnitScadaCsv(csv);
        if (malformed > 0) console.warn(`${context}: skipped ${malformed} malformed row(s)`);
        if (rows.length === 0) {
          // A real Dispatch SCADA file always has data rows. Zero almost
          // certainly means format drift — fail loudly instead of silently
          // marking the file done with no data.
          throw new Error('no D,DISPATCH,UNIT_SCADA rows found');
        }
        const intervals = new Set<number>();
        const batch: MappedRow[] = [];
        for (const row of rows) {
          intervals.add(row.scrapeTime);
          const generatorId = duids.get(row.duid);
          if (generatorId === undefined) {
            unknown.add(row.duid);
            continue;
          }
          batch.push({ scrapeTime: row.scrapeTime, generatorId, value: row.value });
        }
        return { batch, rows: rows.length, intervals };
      },
      async store(batches) {
        const mapped = batches.flat();
        for (let i = 0; i < mapped.length; i += UPSERT_ROWS_PER_BATCH) {
          await upsertValues(env.DB, mapped.slice(i, i + UPSERT_ROWS_PER_BATCH));
        }
        await refreshTouchedRollups(env.DB, mapped); // pre-ledger, per the refreshRollups contract
        return mapped.length;
      },
      finish() {
        if (unknown.size > 0) {
          // Not silently dropped: these DUIDs have SCADA data but no
          // generators row (registration list drift) — the registration
          // refresh (LAB-421) is the fix.
          console.warn(`scada: ${unknown.size} unknown DUID(s), values dropped: ${[...unknown].sort().join(', ')}`);
        }
      },
    };
  },
};

// ---------------------------------------------------------------------------
// DispatchIS feed (LAB-1700)

/**
 * Idempotent chunked upsert of DispatchIS rows; one D1 batch per call.
 * dispatch_region columns COALESCE per field because rrp and total_demand
 * arrive from different CSV tables of the same file — a partial row must
 * never null out the other column on re-ingest.
 */
export async function upsertDispatchRows(db: D1Database, batch: DispatchIsBatch): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < batch.regions.length; i += REGION_CHUNK_ROWS) {
    const chunk = batch.regions.slice(i, i + REGION_CHUNK_ROWS);
    const sql =
      'INSERT INTO dispatch_region (settlement_time, region, rrp, total_demand) VALUES ' +
      chunk.map(() => '(?,?,?,?)').join(',') +
      ' ON CONFLICT(settlement_time, region) DO UPDATE SET ' +
      'rrp = COALESCE(excluded.rrp, rrp), total_demand = COALESCE(excluded.total_demand, total_demand)';
    statements.push(db.prepare(sql).bind(...chunk.flatMap((r) => [r.settlementTime, r.region, r.rrp, r.totalDemand])));
  }
  for (let i = 0; i < batch.interconnectors.length; i += INTERCONNECTOR_CHUNK_ROWS) {
    const chunk = batch.interconnectors.slice(i, i + INTERCONNECTOR_CHUNK_ROWS);
    const sql =
      'INSERT INTO dispatch_interconnector (settlement_time, interconnector, metered_mw_flow) VALUES ' +
      chunk.map(() => '(?,?,?)').join(',') +
      ' ON CONFLICT(settlement_time, interconnector) DO UPDATE SET metered_mw_flow = excluded.metered_mw_flow';
    statements.push(
      db.prepare(sql).bind(...chunk.flatMap((r) => [r.settlementTime, r.interconnector, r.meteredMwFlow])),
    );
  }
  if (statements.length > 0) await db.batch(statements);
}

export const DISPATCH_IS_FEED: Feed<DispatchIsBatch> = {
  label: 'dispatchis',
  currentListingUrl: 'https://nemweb.com.au/Reports/Current/DispatchIS_Reports/',
  archiveListingUrl: 'https://nemweb.com.au/Reports/Archive/DispatchIS_Reports/',
  dailyNameRe: /^PUBLIC_DISPATCHIS_\d{8}\.zip$/,
  dailyNameGlob: 'PUBLIC_DISPATCHIS_????????.zip',
  // async to satisfy the Feed contract (the SCADA processor loads its DUID map).
  async createProcessor(env: Env): Promise<FeedProcessor<DispatchIsBatch>> {
    return {
      parse(csv, context) {
        const { batch, malformed } = parseDispatchIsCsv(csv);
        if (malformed > 0) console.warn(`${context}: skipped ${malformed} malformed row(s)`);
        const rows = batch.regions.length + batch.interconnectors.length;
        if (rows === 0) {
          // Every DispatchIS file carries PRICE/REGIONSUM/INTERCONNECTORRES
          // rows — zero means format drift, fail loud like the SCADA parse.
          throw new Error('no DISPATCH PRICE/REGIONSUM/INTERCONNECTORRES rows found');
        }
        const intervals = new Set<number>();
        for (const r of batch.regions) intervals.add(r.settlementTime);
        for (const r of batch.interconnectors) intervals.add(r.settlementTime);
        return { batch, rows, intervals };
      },
      async store(batches) {
        // A full backfill day is ~3.2k rows → ~112 statements, one batch.
        const merged: DispatchIsBatch = {
          regions: batches.flatMap((b) => b.regions),
          interconnectors: batches.flatMap((b) => b.interconnectors),
        };
        await upsertDispatchRows(env.DB, merged);
        return merged.regions.length + merged.interconnectors.length;
      },
      finish() {},
    };
  },
};

// ---------------------------------------------------------------------------
// CURRENT ingest shell

async function ingestFile<B>(
  env: Env,
  processor: FeedProcessor<B>,
  listingUrl: string,
  filename: string,
  context: string,
): Promise<number> {
  const res = await fetchNemweb(new URL(filename, listingUrl));
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${filename}`);
  const zipBytes = new Uint8Array(await res.arrayBuffer());

  const entries = unzipSync(zipBytes);
  const csvName = Object.keys(entries).find((n) => /\.csv$/i.test(n));
  if (!csvName) throw new Error(`${filename}: zip contains no CSV entry`);

  const { batch } = processor.parse(new TextDecoder().decode(entries[csvName]), context);
  const stored = await processor.store([batch]);

  // Archive the raw zip under a deterministic key; a no-op when already there.
  const key = `current/${filename}`;
  if ((await env.ARCHIVE.head(key)) === null) {
    await env.ARCHIVE.put(key, zipBytes);
  }

  // Ledger write comes last: any failure above leaves the file unrecorded so
  // the next run retries it (every step above is idempotent).
  await env.DB.prepare('INSERT OR IGNORE INTO scrape (filename, ingested_at) VALUES (?, ?)')
    .bind(filename, Math.floor(Date.now() / 1000))
    .run();

  return stored;
}

export async function runIngest<B>(env: Env, feed: Feed<B>): Promise<void> {
  const tag = `ingest:${feed.label}`;
  const listingUrl = feed.currentListingUrl;
  const listing = await fetchNemweb(listingUrl);
  if (!listing.ok) throw new Error(`HTTP ${listing.status} fetching listing ${listingUrl}`);
  const filenames = await extractZipFilenames(listing);

  const seen = await alreadyIngested(env.DB, filenames);
  const pending = filenames.filter((f) => !seen.has(f)); // sorted → oldest first
  if (pending.length === 0) {
    console.log(`${tag}: nothing new (${filenames.length} listed, all ingested)`);
    return;
  }

  const batch = pending.slice(0, MAX_FILES_PER_RUN);
  const processor = await feed.createProcessor(env);
  let ok = 0;
  let failed = 0;
  let stored = 0;
  let consecutiveFailures = 0;

  for (const filename of batch) {
    try {
      stored += await ingestFile(env, processor, listingUrl, filename, `${tag}: ${filename}`);
      ok++;
      consecutiveFailures = 0;
    } catch (err) {
      // Per-file isolation: one bad file logs and the run moves on; it will be
      // retried next run because it never reached the ledger.
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
  console.log(
    `${tag}: ${ok}/${batch.length} file(s) ingested (${stored} values), ${failed} failed, ` +
      `${pending.length - batch.length} deferred to next run`,
  );
}
