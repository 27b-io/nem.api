// SCADA CURRENT ingest (LAB-417): discover new Dispatch SCADA zips on the
// NEMWEB autoindex, unzip in-Worker (fflate — Workers have DecompressionStream
// but no ZIP container support), parse UNIT_SCADA rows, upsert to D1, archive
// the raw zip to R2, and record the filename in the `scrape` ledger.
//
// Idempotency: `scada_values` upserts on its (scrape_time, generator_id) PK,
// the R2 key is deterministic and skipped when present, and the ledger insert
// is OR IGNORE — so re-runs, overlapping crons, and partial-failure retries
// never double-insert. A file is only recorded in the ledger after everything
// else succeeded; any earlier failure leaves it unrecorded and the next run
// retries it.
//
// Gap handling: discovery diffs the full CURRENT listing (~2 days of files)
// against the ledger, oldest-first, so missed cron intervals are caught up
// automatically on the next run. MAX_FILES_PER_RUN bounds a single run's
// wall time; anything deferred is picked up 5 minutes later.

import { unzipSync } from 'fflate';
import type { Env } from './index';
import { parseUnitScadaCsv } from './scada';

export const CURRENT_LISTING_URL = 'https://nemweb.com.au/Reports/CURRENT/Dispatch_SCADA/';

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

// D1 allows 100 bound parameters per statement; 3 per row.
const UPSERT_CHUNK_ROWS = 32;

interface MappedRow {
  scrapeTime: number;
  generatorId: number;
  value: number;
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

async function alreadyIngested(db: D1Database, filenames: string[]): Promise<Set<string>> {
  if (filenames.length === 0) return new Set();
  // Filenames sort chronologically (fixed prefix + timestamp), so one range
  // query bounds the ledger scan to the listing's window however large the
  // ledger grows.
  const oldest = filenames.reduce((a, b) => (a < b ? a : b));
  const { results } = await db
    .prepare('SELECT filename FROM scrape WHERE filename >= ?')
    .bind(oldest)
    .all<{ filename: string }>();
  return new Set(results.map((r) => r.filename));
}

/** Idempotent chunked upsert; one D1 batch (= one transaction) per call. */
export async function upsertValues(db: D1Database, rows: MappedRow[]): Promise<void> {
  if (rows.length === 0) return;
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_ROWS) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK_ROWS);
    const sql =
      'INSERT INTO scada_values (scrape_time, generator_id, value) VALUES ' +
      chunk.map(() => '(?,?,?)').join(',') +
      ' ON CONFLICT(scrape_time, generator_id) DO UPDATE SET value = excluded.value';
    statements.push(db.prepare(sql).bind(...chunk.flatMap((r) => [r.scrapeTime, r.generatorId, r.value])));
  }
  await db.batch(statements);
}

async function ingestFile(
  env: Env,
  listingUrl: string,
  filename: string,
  duids: Map<string, number>,
): Promise<{ inserted: number; unknownDuids: string[] }> {
  const res = await fetch(new URL(filename, listingUrl));
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${filename}`);
  const zipBytes = new Uint8Array(await res.arrayBuffer());

  const entries = unzipSync(zipBytes);
  const csvName = Object.keys(entries).find((n) => /\.csv$/i.test(n));
  if (!csvName) throw new Error(`${filename}: zip contains no CSV entry`);

  const { rows, malformed } = parseUnitScadaCsv(new TextDecoder().decode(entries[csvName]));
  if (malformed > 0) console.warn(`ingest: ${filename}: skipped ${malformed} malformed row(s)`);
  if (rows.length === 0) {
    // A real Dispatch SCADA file always has data rows. Zero almost certainly
    // means format drift — fail loudly (file stays unrecorded, retries next
    // run) instead of silently marking it done with no data.
    throw new Error(`${filename}: no D,DISPATCH,UNIT_SCADA rows found`);
  }

  const unknown = new Set<string>();
  const mapped: MappedRow[] = [];
  for (const row of rows) {
    const generatorId = duids.get(row.duid);
    if (generatorId === undefined) {
      unknown.add(row.duid);
      continue;
    }
    mapped.push({ scrapeTime: row.scrapeTime, generatorId, value: row.value });
  }

  await upsertValues(env.DB, mapped);

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

  return { inserted: mapped.length, unknownDuids: [...unknown] };
}

export async function runIngest(env: Env, listingUrl: string = CURRENT_LISTING_URL): Promise<void> {
  const listing = await fetch(listingUrl);
  if (!listing.ok) throw new Error(`HTTP ${listing.status} fetching listing ${listingUrl}`);
  const filenames = await extractZipFilenames(listing);

  const seen = await alreadyIngested(env.DB, filenames);
  const pending = filenames.filter((f) => !seen.has(f)); // sorted → oldest first
  if (pending.length === 0) {
    console.log(`ingest: nothing new (${filenames.length} listed, all ingested)`);
    return;
  }

  const batch = pending.slice(0, MAX_FILES_PER_RUN);
  const duids = await loadDuidMap(env.DB);
  const unknown = new Set<string>();
  let ok = 0;
  let failed = 0;
  let inserted = 0;
  let consecutiveFailures = 0;

  for (const filename of batch) {
    try {
      const result = await ingestFile(env, listingUrl, filename, duids);
      ok++;
      inserted += result.inserted;
      consecutiveFailures = 0;
      for (const duid of result.unknownDuids) unknown.add(duid);
    } catch (err) {
      // Per-file isolation: one bad file logs and the run moves on; it will be
      // retried next run because it never reached the ledger.
      failed++;
      consecutiveFailures++;
      console.error(`ingest: ${filename} failed:`, err instanceof Error ? err.message : err);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(
          `ingest: aborting run after ${consecutiveFailures} consecutive failures ` +
            '(NEMWEB rate limit?); next run retries from here',
        );
        break;
      }
    }
  }

  if (unknown.size > 0) {
    // Not silently dropped: these DUIDs have SCADA data but no generators row
    // (registration list drift) — the Stage 4 registration refresh is the fix.
    console.warn(`ingest: ${unknown.size} unknown DUID(s), values dropped: ${[...unknown].sort().join(', ')}`);
  }
  console.log(
    `ingest: ${ok}/${batch.length} file(s) ingested (${inserted} values), ${failed} failed, ` +
      `${pending.length - batch.length} deferred to next run`,
  );
}
