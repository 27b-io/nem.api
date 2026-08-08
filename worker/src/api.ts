// HTTP query API (LAB-418): /api/v2/values, /api/v2/values/aggregate,
// /api/v2/dispatch, /api/v2/generators, /api/v2/intensity — a greenfields v2
// contract over the D1 store. PUBLIC
// (ray, 2026-07-24: public until abuse is detected), so the contract in
// worker/API.md (owned jointly with the LAB-419 frontend) is the product.
// The legacy restify API (api/v1.1) is reference-only, not a contract.
//
// Contract essentials:
// - Columnar, lib-agnostic payload: shared ascending `timestamps` + aligned
//   per-series `values` arrays with null gaps.
// - Buckets are period-ENDING and aligned to NEM time (AEST, UTC+10, no DST),
//   matching AEMO's period-ending SETTLEMENTDATE convention; daily buckets
//   end at AEST midnight.
// - Every user value reaches SQL as a bound parameter; sort/group_by/
//   resolution identifiers are allowlisted. No `sql`/`vars` echo.
// - No time params defaults to the last 24 hours.
// - Aggregate values are NET MW: storage charging / station load draw stays
//   negative through SUM (see API.md for the convention).

import type { Env } from './index';
import { bucketExpr, nemBucket } from './rollups';

const MAX_LIMIT = 300000;
const DEFAULT_WINDOW_SECONDS = 86400;
const RESOLUTIONS = [300, 1800, 3600, 86400];

export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

// Parsing/resolution helpers below are exported for src/cache.ts: the cache
// key builder reuses the exact functions the handlers use, so key semantics
// cannot drift from query semantics (canonical param + alias, precedence,
// defaults all stay single-sourced here).

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

function jsonError(status: number, message: string): Response {
  return json({ error: message }, status);
}

/** First non-empty value among alias names; alias order encodes legacy precedence. */
export function firstParam(params: URLSearchParams, aliases: string[]): string | undefined {
  for (const name of aliases) {
    const value = params.get(name);
    if (value !== null && value !== '') return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Time grammar (port of queryParser.time)

export interface TimeWindow {
  start?: number;
  end?: number;
  exact?: number;
}

/**
 * Unix seconds from either a digit string (unix seconds) or an ISO date
 * string. Offset-less ISO strings are interpreted as NEM time (AEST, +10:00)
 * — never the runtime timezone — and date-only strings mean AEST midnight;
 * explicit `Z`/`±hh:mm` offsets are honoured as given.
 */
function parseTimeParam(name: string, raw: string): number {
  if (/^\d+$/.test(raw)) return Number(raw);
  let iso = raw;
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)) {
    iso = (iso.includes('T') ? iso : `${iso}T00:00:00`) + '+10:00';
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new ApiError(400, `invalid ${name}: expected unix seconds or an ISO date string`);
  return Math.floor(ms / 1000);
}

/** Calendar-month arithmetic, clamped to the target month's last day (moment behaviour). */
function addCalendarMonths(unixSeconds: number, months: number): number {
  const d = new Date(unixSeconds * 1000);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, daysInMonth));
  return Math.floor(d.getTime() / 1000);
}

// Legacy else-if precedence: minutes > hours > days > weeks > months.
export const RELATIVE_WINDOWS: Array<[name: string, secondsPerUnit: number | 'months']> = [
  ['minutes', 60],
  ['hours', 3600],
  ['days', 86400],
  ['weeks', 604800],
  ['months', 'months'],
];

/**
 * Legacy window semantics: a relative window with no start/end counts back
 * from now (open-ended end); with a start it runs [start, start+window]
 * (a given end is ignored, as legacy did); with only an end, [end-window, end].
 * Without a window, `time` (exact) / `time_start` / `time_end` apply directly.
 */
export function resolveTimeWindow(params: URLSearchParams, nowSeconds: number): TimeWindow {
  const rawStart = firstParam(params, ['time_start']);
  const rawEnd = firstParam(params, ['time_end']);
  const start = rawStart === undefined ? undefined : parseTimeParam('time_start', rawStart);
  const end = rawEnd === undefined ? undefined : parseTimeParam('time_end', rawEnd);

  for (const [name, unit] of RELATIVE_WINDOWS) {
    const raw = firstParam(params, [name]);
    if (raw === undefined) continue;
    if (!/^\d+$/.test(raw) || Number(raw) === 0) {
      throw new ApiError(400, `invalid ${name}: expected a positive integer`);
    }
    const n = Number(raw);
    const sub = (t: number) => (unit === 'months' ? addCalendarMonths(t, -n) : t - n * unit);
    const add = (t: number) => (unit === 'months' ? addCalendarMonths(t, n) : t + n * unit);
    if (start === undefined && end === undefined) return { start: sub(nowSeconds) };
    if (start !== undefined) return { start, end: add(start) };
    return { start: sub(end as number), end };
  }

  const rawExact = firstParam(params, ['time']);
  const exact = rawExact === undefined ? undefined : parseTimeParam('time', rawExact);
  if (start === undefined && end === undefined && exact === undefined) {
    return { start: nowSeconds - DEFAULT_WINDOW_SECONDS };
  }
  return { start, end, exact };
}

/**
 * The bucket width this window gets when the caller names none: coarse enough
 * that a wide window never ships a 5-minute-resolution payload. Also the
 * FLOOR that /api/v2/intensity enforces on an explicit `resolution` — see
 * handleIntensity for why that route refuses finer and its siblings don't.
 */
export function autoResolution(window: TimeWindow, nowSeconds: number): number {
  if (window.exact !== undefined && window.start === undefined && window.end === undefined) return 300;
  const span = (window.end ?? nowSeconds) - (window.start ?? 0);
  if (span <= 3 * 86400) return 300;
  if (span <= 14 * 86400) return 1800;
  if (span <= 90 * 86400) return 3600;
  return 86400;
}

/**
 * Bucket width in seconds. Explicit `resolution` must be on the allowlist;
 * otherwise auto-picked from the window span.
 */
export function resolveResolution(params: URLSearchParams, window: TimeWindow, nowSeconds: number): number {
  const raw = firstParam(params, ['resolution']);
  if (raw !== undefined) {
    const n = Number(raw);
    if (!RESOLUTIONS.includes(n)) {
      throw new ApiError(400, `invalid resolution: allowed values (seconds) are ${RESOLUTIONS.join(', ')}`);
    }
    return n;
  }
  return autoResolution(window, nowSeconds);
}

/**
 * Whether a request is served from the LAB-1696 rollup tables rather than raw
 * `scada_values`. THE one definition: both handlers route on it and src/cache.ts
 * decides the closed-window test with it. Rollup-served responses report the
 * FULL bucket straddling the window edge, so a cache entry cannot be treated
 * as closed until that whole bucket has ended — three copies of this predicate
 * is exactly how that invariant would come apart.
 */
export function servedFromRollups(window: TimeWindow, resolution: number): boolean {
  return window.exact === undefined && resolution >= 3600;
}

// ---------------------------------------------------------------------------
// Generator filter grammar (port of queryParser.parseGeneratorParameters)

interface SqlFragment {
  sql: string;
  binds: (string | number)[];
}

// One canonical param per field plus at most one alias (the storage column
// name, or `state` for region). First non-empty wins — canonical over alias.
// `region` is the canonical NEM dimension (QLD1/NSW1/VIC1/SA1/TAS1), stored
// in the `state` column.
export const GENERATOR_FILTERS: Array<{ column: string; aliases: string[] }> = [
  { column: 'state', aliases: ['region', 'state'] },
  { column: 'fuel_type', aliases: ['fuel', 'fuel_type'] },
  { column: 'fuel_description', aliases: ['fuel_desc', 'fuel_description'] },
  { column: 'technology_type', aliases: ['tech', 'technology_type'] },
  { column: 'technology_description', aliases: ['tech_desc', 'technology_description'] },
  { column: 'duid', aliases: ['duid'] },
];

// The only filter /api/v2/dispatch accepts (dispatch_region has no generator
// dimensions). Exported for src/cache.ts, same single-sourcing as above.
export const DISPATCH_FILTERS: Array<{ column: string; aliases: string[] }> = [
  { column: 'region', aliases: ['region', 'state'] },
];

// Operator inference, all values bound: a comma means IN, `*` means LIKE
// (`*` -> `%`, with literal `%`/`_` escaped — `*` is the only public
// wildcard), anything else `=`.
function filterClause(column: string, qualifiedColumn: string, raw: string): SqlFragment {
  if (raw.includes(',')) {
    const items = raw.split(',').filter((s) => s !== '');
    if (items.length === 0) throw new ApiError(400, `empty value list for ${column}`);
    return { sql: `${qualifiedColumn} IN (${items.map(() => '?').join(',')})`, binds: items };
  }
  if (raw.includes('*')) {
    const pattern = raw.replace(/[\\%_]/g, (m) => `\\${m}`).replace(/\*/g, '%');
    return { sql: `${qualifiedColumn} LIKE ? ESCAPE '\\'`, binds: [pattern] };
  }
  return { sql: `${qualifiedColumn} = ?`, binds: [raw] };
}

function generatorFilters(params: URLSearchParams, columnPrefix = ''): SqlFragment[] {
  const fragments: SqlFragment[] = [];
  for (const { column, aliases } of GENERATOR_FILTERS) {
    const raw = firstParam(params, aliases);
    if (raw !== undefined) fragments.push(filterClause(column, columnPrefix + column, raw));
  }
  return fragments;
}

// ---------------------------------------------------------------------------
// limit / offset / sort

/** Plain integer clamp: 1..300000, default = the cap. Garbage is a 400, not a silent fallback. */
export function resolveLimit(params: URLSearchParams): { limit: number; offset: number } {
  const rawLimit = firstParam(params, ['limit']);
  let limit = MAX_LIMIT;
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) === 0) {
      throw new ApiError(400, `invalid limit: expected an integer between 1 and ${MAX_LIMIT}`);
    }
    limit = Math.min(Number(rawLimit), MAX_LIMIT);
  }
  const rawOffset = firstParam(params, ['offset']);
  if (rawOffset !== undefined && !/^\d+$/.test(rawOffset)) {
    throw new ApiError(400, 'invalid offset: expected a non-negative integer');
  }
  return { limit, offset: rawOffset === undefined ? 0 : Number(rawOffset) };
}

// Allowlisted sort columns — never interpolate user text into ORDER BY.
// Keys are the public names; values are columns of the bucketed SELECT.
const SORT_COLUMNS: Record<string, string> = {
  time: 'bucket',
  generator_id: 'gid',
  value: 'value',
};

export function resolveOrder(params: URLSearchParams): string {
  const raw = firstParam(params, ['sort', 'order']);
  if (raw === undefined) return 'ORDER BY bucket ASC, gid ASC';
  const [field, dirRaw] = raw.split(',');
  const column = SORT_COLUMNS[field];
  const direction = (dirRaw || 'asc').toLowerCase();
  if (column === undefined || (direction !== 'asc' && direction !== 'desc')) {
    throw new ApiError(
      400,
      `invalid sort: expected <field>[,asc|desc] with field one of ${Object.keys(SORT_COLUMNS).join(', ')}`,
    );
  }
  // Secondary keys keep offset paging deterministic.
  return `ORDER BY ${column} ${direction}, bucket ASC, gid ASC`;
}

// ---------------------------------------------------------------------------
// Shared shaping

/** Pivot (bucket, key, value) rows onto a shared time axis; missing points stay null. */
function pivot<K>(rows: Array<{ bucket: number; key: K; value: number }>): {
  timestamps: number[];
  byKey: Map<K, (number | null)[]>;
} {
  const timestampSet = new Set<number>();
  for (const row of rows) timestampSet.add(row.bucket);
  const timestamps = [...timestampSet].sort((a, b) => a - b);
  const index = new Map(timestamps.map((t, i) => [t, i]));
  const byKey = new Map<K, (number | null)[]>();
  for (const row of rows) {
    let values = byKey.get(row.key);
    if (values === undefined) {
      values = new Array<number | null>(timestamps.length).fill(null);
      byKey.set(row.key, values);
    }
    values[index.get(row.bucket) as number] = row.value;
  }
  return { timestamps, byKey };
}

function timeClauses(window: TimeWindow, column: string): SqlFragment[] {
  const clauses: SqlFragment[] = [];
  if (window.exact !== undefined) clauses.push({ sql: `${column} = ?`, binds: [window.exact] });
  if (window.start !== undefined) clauses.push({ sql: `${column} >= ?`, binds: [window.start] });
  if (window.end !== undefined) clauses.push({ sql: `${column} <= ?`, binds: [window.end] });
  return clauses;
}

// ---------------------------------------------------------------------------
// Handlers

async function handleValues(env: Env, params: URLSearchParams): Promise<Response> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const window = resolveTimeWindow(params, nowSeconds);
  const resolution = resolveResolution(params, window, nowSeconds);
  const { limit, offset } = resolveLimit(params);
  const filters = generatorFilters(params);

  const where = timeClauses(window, 'sv.scrape_time');
  if (filters.length > 0) {
    where.push({
      sql: `sv.generator_id IN (SELECT id FROM generators WHERE ${filters.map((f) => f.sql).join(' AND ')})`,
      binds: filters.flatMap((f) => f.binds),
    });
  }

  const sql =
    `SELECT ${bucketExpr('sv.scrape_time', resolution)} AS bucket, ` +
    'sv.generator_id AS gid, ROUND(AVG(sv.value), 4) AS value ' +
    'FROM scada_values sv ' +
    `WHERE ${where.map((c) => c.sql).join(' AND ')} ` +
    `GROUP BY bucket, gid ${resolveOrder(params)} LIMIT ? OFFSET ?`;
  const binds = [...where.flatMap((c) => c.binds), limit, offset];

  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all<{ bucket: number; gid: number; value: number }>();

  const { timestamps, byKey } = pivot(results.map((r) => ({ bucket: r.bucket, key: r.gid, value: r.value })));

  // One small full-table read beats chunked IN() binding for series metadata.
  const generators = await env.DB.prepare('SELECT id, duid, name, fuel_type FROM generators').all<{
    id: number;
    duid: string;
    name: string;
    fuel_type: string | null;
  }>();
  const metaById = new Map(generators.results.map((g) => [g.id, g]));

  const series = [...byKey.entries()]
    .sort(([a], [b]) => a - b)
    .map(([gid, values]) => {
      const meta = metaById.get(gid);
      return {
        id: gid,
        duid: meta?.duid ?? null,
        name: meta?.name ?? null,
        fuel: meta?.fuel_type ?? null,
        values,
      };
    });

  return json({
    start: window.start ?? null,
    end: window.end ?? null,
    resolution,
    truncated: results.length === limit,
    timestamps,
    series,
  });
}

// `region` is the canonical NEM dimension; `state` (the storage column) is
// kept as its alias. `fuel`/`tech` group the corresponding *_type columns.
const GROUP_COLUMNS: Record<string, string> = {
  fuel: 'fuel_type',
  tech: 'technology_type',
  region: 'state',
  state: 'state',
};

async function handleAggregate(env: Env, params: URLSearchParams): Promise<Response> {
  const groupBy = firstParam(params, ['group_by']);
  const groupColumn = groupBy === undefined ? undefined : GROUP_COLUMNS[groupBy];
  if (groupColumn === undefined) {
    throw new ApiError(400, `invalid group_by: expected one of ${Object.keys(GROUP_COLUMNS).join(', ')}`);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const window = resolveTimeWindow(params, nowSeconds);
  const resolution = resolveResolution(params, window, nowSeconds);
  const { limit, offset } = resolveLimit(params);

  let sql: string;
  let binds: (string | number)[];
  if (servedFromRollups(window, resolution)) {
    // Rollup path (LAB-1696): GROUP-BYing raw 5-minute rows over long windows
    // exhausts SQLite's memory budget (D1 SQLITE_NOMEM observed at ~90 days),
    // so resolution 3600/86400 reads the pre-aggregated per-generator tables
    // maintained by ingest (src/rollups.ts). Semantics: value = the group's
    // summed net MW over the bucket divided by the bucket's GLOBAL distinct-
    // interval count — identical to the raw path whenever the group has a
    // sample in every ingested interval of the bucket (the production norm:
    // every registered DUID reports each dispatch interval); a group missing
    // intervals inside a bucket averages them as 0 MW contribution instead of
    // being skipped. A bucket straddling the window edge reports the FULL
    // bucket's mean. Exact `time=` lookups stay raw — they read one interval.
    const table = resolution === 86400 ? 'scada_daily' : 'scada_hourly';
    const where: SqlFragment[] = [];
    if (window.start !== undefined) where.push({ sql: 'r.bucket >= ?', binds: [nemBucket(window.start, resolution)] });
    if (window.end !== undefined) where.push({ sql: 'r.bucket <= ?', binds: [nemBucket(window.end, resolution)] });
    where.push(...generatorFilters(params, 'g.'));
    // Interval counts are stored per hourly bucket; a daily bucket is exactly
    // 24 NEM-aligned hours (no DST), so daily denominators sum the hourly ones.
    const intervalsJoin =
      resolution === 86400
        ? `JOIN (SELECT ${bucketExpr('bucket', 86400)} AS day_bucket, SUM(n_intervals) AS n_intervals ` +
          'FROM scada_intervals GROUP BY day_bucket) i ON i.day_bucket = r.bucket '
        : 'JOIN scada_intervals i ON i.bucket = r.bucket ';
    sql =
      `SELECT r.bucket AS bucket, COALESCE(g.${groupColumn}, '') AS grp, ` +
      // MAX() only satisfies the aggregate context — every joined row of a
      // bucket carries the same n_intervals.
      'ROUND(SUM(r.sum_value) / MAX(i.n_intervals), 4) AS value ' +
      `FROM ${table} r JOIN generators g ON g.id = r.generator_id ` +
      intervalsJoin +
      `WHERE ${where.map((c) => c.sql).join(' AND ')} ` +
      // Qualified r.bucket: the hourly intervals join carries a bucket column
      // too, so the bare output alias would be ambiguous.
      'GROUP BY r.bucket, grp ORDER BY r.bucket ASC, grp ASC LIMIT ? OFFSET ?';
    binds = [...where.flatMap((c) => c.binds), limit, offset];
  } else {
    const where = [...timeClauses(window, 'sv.scrape_time'), ...generatorFilters(params, 'g.')];

    // Inner query: instantaneous NET total MW per (dispatch interval, group) —
    // negative values (storage charging, station load draw) sum through, per
    // the net convention in API.md. Generators with a NULL group value land in
    // the '' series rather than being dropped. Outer query: mean of those
    // totals per bucket — mean-of-sums, which stays correct when a generator
    // misses an interval inside the bucket.
    sql =
      `SELECT ${bucketExpr('t', resolution)} AS bucket, grp, ROUND(AVG(total), 4) AS value FROM (` +
      `SELECT sv.scrape_time AS t, COALESCE(g.${groupColumn}, '') AS grp, SUM(sv.value) AS total ` +
      'FROM scada_values sv JOIN generators g ON g.id = sv.generator_id ' +
      `WHERE ${where.map((c) => c.sql).join(' AND ')} ` +
      'GROUP BY t, grp' +
      ') GROUP BY bucket, grp ORDER BY bucket ASC, grp ASC LIMIT ? OFFSET ?';
    binds = [...where.flatMap((c) => c.binds), limit, offset];
  }

  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all<{ bucket: number; grp: string; value: number }>();

  const { timestamps, byKey } = pivot(results.map((r) => ({ bucket: r.bucket, key: r.grp, value: r.value })));
  const series = [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, values]) => ({ key, values }));

  return json({
    group_by: groupBy,
    start: window.start ?? null,
    end: window.end ?? null,
    resolution,
    truncated: results.length === limit,
    timestamps,
    series,
  });
}

/**
 * GET /api/v2/dispatch (LAB-1700): per-region 5-minute spot price and demand
 * from DispatchIS, bucketed with the same window/resolution grammar as
 * `values`. Price carries BOTH the bucket mean and the bucket max — a
 * $10k/MWh spike must not vanish into an hourly mean. Demand is mean-only.
 * Reads raw dispatch_region rows at every resolution: the table is ~5 rows
 * per interval (~570k rows over the full retention), orders of magnitude
 * under the raw-path memory ceiling that forced rollups for scada_values.
 * No group_by (region IS the series), no sort (fixed time-ascending, like
 * aggregate). Interconnector flows are stored but deliberately not exposed.
 */
async function handleDispatch(env: Env, params: URLSearchParams): Promise<Response> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const window = resolveTimeWindow(params, nowSeconds);
  const resolution = resolveResolution(params, window, nowSeconds);
  const { limit, offset } = resolveLimit(params);

  const where = timeClauses(window, 'settlement_time');
  for (const { column, aliases } of DISPATCH_FILTERS) {
    const raw = firstParam(params, aliases);
    if (raw !== undefined) where.push(filterClause(column, column, raw));
  }

  // AVG/MAX ignore NULL sides of a partially-ingested row; an all-NULL bucket
  // yields null in the aligned arrays, same "no sample" semantics as values.
  const sql =
    `SELECT ${bucketExpr('settlement_time', resolution)} AS bucket, region, ` +
    'ROUND(AVG(rrp), 4) AS price, ROUND(MAX(rrp), 4) AS price_max, ROUND(AVG(total_demand), 4) AS demand ' +
    'FROM dispatch_region ' +
    `WHERE ${where.map((c) => c.sql).join(' AND ')} ` +
    'GROUP BY bucket, region ORDER BY bucket ASC, region ASC LIMIT ? OFFSET ?';
  const binds = [...where.flatMap((c) => c.binds), limit, offset];

  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all<{ bucket: number; region: string; price: number | null; price_max: number | null; demand: number | null }>();

  // Pivot the three metrics onto one shared time axis (pivot() is
  // single-metric; three passes over ≤ a few thousand rows is not worth a
  // generalisation).
  const timestamps = [...new Set(results.map((r) => r.bucket))].sort((a, b) => a - b);
  const index = new Map(timestamps.map((t, i) => [t, i]));
  const byRegion = new Map<string, { price: (number | null)[]; price_max: (number | null)[]; demand: (number | null)[] }>();
  for (const row of results) {
    let series = byRegion.get(row.region);
    if (series === undefined) {
      const empty = () => new Array<number | null>(timestamps.length).fill(null);
      series = { price: empty(), price_max: empty(), demand: empty() };
      byRegion.set(row.region, series);
    }
    const i = index.get(row.bucket) as number;
    series.price[i] = row.price;
    series.price_max[i] = row.price_max;
    series.demand[i] = row.demand;
  }

  const series = [...byRegion.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([region, s]) => ({ region, ...s }));

  return json({
    start: window.start ?? null,
    end: window.end ?? null,
    resolution,
    truncated: results.length === limit,
    timestamps,
    series,
  });
}

/**
 * GET /api/v2/rooftop (LAB-1701): per-region rooftop PV generation from
 * AEMO's ROOFTOP_PV/ACTUAL MEASUREMENT estimate, bucketed with the same
 * window/resolution grammar as `values`. Same shape and constraints as
 * `dispatch` (region IS the series, no group_by, no sort), same raw-rows
 * rationale (~240 rows/day — no rollups needed).
 *
 * The source is 30-minute, so buckets exist only where an estimate does:
 * at resolution 300 rows land solely on half-hour boundaries (the response
 * is NOT dense at 300 — consumers get the native half-hour axis), and the
 * most recent ~30-60 minutes have no bucket at all until AEMO publishes the
 * interval. Absent buckets are absent/null, never zero and never
 * interpolated — this is an ESTIMATE feed, not SCADA telemetry, and the API
 * must not manufacture readings the estimator has not produced.
 */
async function handleRooftop(env: Env, params: URLSearchParams): Promise<Response> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const window = resolveTimeWindow(params, nowSeconds);
  const resolution = resolveResolution(params, window, nowSeconds);
  const { limit, offset } = resolveLimit(params);

  const where = timeClauses(window, 'interval_time');
  for (const { column, aliases } of DISPATCH_FILTERS) {
    const raw = firstParam(params, aliases);
    if (raw !== undefined) where.push(filterClause(column, column, raw));
  }

  const sql =
    `SELECT ${bucketExpr('interval_time', resolution)} AS bucket, region, ` +
    'ROUND(AVG(power), 4) AS value ' +
    'FROM rooftop_pv ' +
    `WHERE ${where.map((c) => c.sql).join(' AND ')} ` +
    'GROUP BY bucket, region ORDER BY bucket ASC, region ASC LIMIT ? OFFSET ?';
  const binds = [...where.flatMap((c) => c.binds), limit, offset];

  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all<{ bucket: number; region: string; value: number }>();

  const { timestamps, byKey } = pivot(results.map((r) => ({ bucket: r.bucket, key: r.region, value: r.value })));
  const series = [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([region, power]) => ({ region, power }));

  return json({
    start: window.start ?? null,
    end: window.end ?? null,
    resolution,
    truncated: results.length === limit,
    timestamps,
    series,
  });
}

// ---------------------------------------------------------------------------
// Carbon intensity (LAB-1698)

/**
 * AEMO publishes its official daily index against the AEST midnight that
 * STARTS the day (cdeii_daily.settlement_date); our daily buckets are
 * period-ENDING, so the bucket covering that day is labelled one day later.
 * This is the single place the two conventions are bridged.
 */
const CDEII_DAY_SECONDS = 86400;

/** The NEM-wide rollup series, reported alongside the five region series. */
const NEM_KEY = 'NEM';

// Column names are deliberately NOT `emissions` / `mw`: these are sums of MW
// readings over a bucket's intervals, not tonnes and not MWh. `cdeii_daily`
// has real `emissions` (tCO2-e) and `sent_out_energy` (MWh) columns, and the
// two differ by the interval count — naming these the same would invite
// someone to publish an "emissions" figure that is wrong by a factor of 12.
// Only the RATIO is meaningful, and the interval count cancels out of it.
interface IntensityRow {
  bucket: number;
  region: string;
  /** Σ of every generator's clamped bucket output, factored or not. */
  mw_total: number;
  /** …restricted to generators that DO carry a published factor. */
  mw_factored: number;
  /** Σ(clamped output × factor): the ratio's numerator, in MW·tCO2-e/MWh. */
  factor_weighted: number;
}

interface IntensityTotals {
  mwTotal: number;
  mwFactored: number;
  factorWeighted: number;
}

/**
 * Regional carbon intensity = Σ(MW × factor) / Σ(MW), energy-weighted over the
 * bucket — the same ratio-of-sums AEMO's own daily index uses
 * (TOTAL_EMISSIONS / TOTAL_SENT_OUT_ENERGY), so the two are directly
 * comparable.
 *
 * Negative-MW rule: a generator's NET output over a bucket is clamped at zero,
 * so a unit that is a net consumer in that bucket (a charging battery, a pump
 * load, station draw) contributes to neither numerator nor denominator — it is
 * not sending anything out. At resolution 300 a bucket is a single dispatch
 * interval, so this is exactly "drop negative readings"; at coarser buckets it
 * is the per-generator net. Leaving charging in the denominator would shrink
 * it and inflate intensity, which is the wrong direction and would be worst
 * exactly when the grid is cleanest.
 *
 * Both paths share one outer query and differ only in the inner SELECT that
 * produces per-(bucket, generator) clamped MW: the rollup tables already STORE
 * what the raw path has to GROUP BY. That is what makes them the same number
 * rather than merely close — structurally, not by assertion. The interval
 * count the aggregate endpoint needs as a denominator cancels out of this
 * ratio entirely, so no scada_intervals join is required here.
 *
 * The identity holds for every bucket fully inside the window. At the edges
 * the rollup path reports the WHOLE straddling bucket, exactly as
 * /values/aggregate does (documented in worker/API.md) — the raw path clips to
 * the window instead.
 *
 * ponytail: clamping the bucket NET is deliberately chosen over the strictly
 * more accurate per-interval `value > 0`, which would count a battery's
 * discharge intervals even in a bucket it spent net charging. Per-interval
 * clamping is impossible on the rollup path (scada_hourly stores only the net
 * sum), so adopting it would make resolution 1800 and 3600 disagree about the
 * same hour for reasons a consumer cannot see. A public series that reports
 * one number per hour however it was served is worth more than sub-1%
 * precision on sub-1% of generation. Upgrade path if that ever inverts: add a
 * sum_positive column to scada_hourly/scada_daily and re-backfill — then both
 * paths can clamp per interval and stay identical.
 */
async function handleIntensity(env: Env, params: URLSearchParams): Promise<Response> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const window = resolveTimeWindow(params, nowSeconds);
  const resolution = resolveResolution(params, window, nowSeconds);

  // Unlike the older routes, this one REFUSES a resolution finer than the
  // window's auto-pick. The raw path here groups by (bucket, generator) —
  // far higher cardinality than the aggregate's (bucket, group) — so
  // `resolution=300&months=13` is the SQLITE_NOMEM shape LAB-1696 exists to
  // avoid, reachable unauthenticated with a 100-byte request. The sibling
  // routes still carry that hole for contract-compatibility reasons
  // (LAB-1721); this route is new, so it never inherits it. Refusing also
  // bounds the response to at most ~900 buckets x 6 regions at any allowed
  // pairing, which is why intensity needs no limit/offset at all.
  const floor = autoResolution(window, nowSeconds);
  if (resolution < floor) {
    throw new ApiError(
      400,
      `invalid resolution: ${resolution} is too fine for this window — use ${floor} or coarser`,
    );
  }

  // Generator filters and `sort` are deliberately NOT accepted: intensity is
  // defined per region and every region is always returned, and the emissions
  // of a fuel subset over the output of that same subset is a confidently
  // wrong number.
  //
  // ONE outer query over an inner per-(bucket, generator) clamped-MW SELECT.
  // The paths differ only in that inner SELECT, which is what makes the
  // identity above structural rather than asserted.
  const fromRollups = servedFromRollups(window, resolution);
  let inner: string;
  let binds: (string | number)[];

  if (fromRollups) {
    const where: SqlFragment[] = [];
    if (window.start !== undefined) where.push({ sql: 'r.bucket >= ?', binds: [nemBucket(window.start, resolution)] });
    if (window.end !== undefined) where.push({ sql: 'r.bucket <= ?', binds: [nemBucket(window.end, resolution)] });
    // Rollup rows are ALREADY per (bucket, generator), so there is nothing to
    // group — project and clamp. MAX(x, 0) is SQLite's two-argument SCALAR
    // max, not the aggregate.
    inner =
      `SELECT r.bucket AS bucket, COALESCE(g.state, '') AS region, f.factor AS factor, MAX(r.sum_value, 0) AS mw ` +
      `FROM ${resolution === 86400 ? 'scada_daily' : 'scada_hourly'} r ` +
      'JOIN generators g ON g.id = r.generator_id ' +
      'LEFT JOIN emission_factors f ON f.duid = g.duid ' +
      `WHERE ${where.map((c) => c.sql).join(' AND ')}`;
    binds = where.flatMap((c) => c.binds);
  } else {
    const where = timeClauses(window, 'sv.scrape_time');
    // region/factor sit in the GROUP BY only for clarity; both are
    // functionally determined by generator_id.
    inner =
      `SELECT ${bucketExpr('sv.scrape_time', resolution)} AS bucket, COALESCE(g.state, '') AS region, ` +
      'f.factor AS factor, MAX(SUM(sv.value), 0) AS mw ' +
      'FROM scada_values sv JOIN generators g ON g.id = sv.generator_id ' +
      'LEFT JOIN emission_factors f ON f.duid = g.duid ' +
      `WHERE ${where.map((c) => c.sql).join(' AND ')} ` +
      'GROUP BY bucket, sv.generator_id, region, factor';
    binds = where.flatMap((c) => c.binds);
  }

  const { results } = await env.DB.prepare(
    'SELECT bucket, region, SUM(mw) AS mw_total, ' +
      'SUM(CASE WHEN factor IS NULL THEN 0 ELSE mw END) AS mw_factored, ' +
      `SUM(COALESCE(factor, 0) * mw) AS factor_weighted FROM (${inner}) ` +
      'GROUP BY bucket, region ORDER BY bucket ASC, region ASC',
  )
    .bind(...binds)
    .all<IntensityRow>();

  // Shape: bucket -> region -> totals, plus a NEM total accumulated as we go
  // (Σ over regions of both halves of the ratio — NOT the mean of the regional
  // intensities, which would weight a quiet Tasmania like a loaded NSW). This
  // is only sound because no row was dropped: there is no LIMIT above, so a
  // bucket's NEM total always covers every region that reported in it.
  const byBucket = new Map<number, Map<string, IntensityTotals>>();
  const regions = new Set<string>([NEM_KEY]);
  for (const row of results) {
    let bucket = byBucket.get(row.bucket);
    if (bucket === undefined) byBucket.set(row.bucket, (bucket = new Map()));
    bucket.set(row.region, {
      mwTotal: row.mw_total,
      mwFactored: row.mw_factored,
      factorWeighted: row.factor_weighted,
    });
    regions.add(row.region);

    const nem = bucket.get(NEM_KEY) ?? { mwTotal: 0, mwFactored: 0, factorWeighted: 0 };
    nem.mwTotal += row.mw_total;
    nem.mwFactored += row.mw_factored;
    nem.factorWeighted += row.factor_weighted;
    bucket.set(NEM_KEY, nem);
  }

  const timestamps = [...byBucket.keys()].sort((a, b) => a - b);
  // AEMO's index is daily, so it lines up only when the buckets ARE whole NEM
  // days: rollup-served (whole buckets) AND daily. `time=<interval>` with
  // `resolution=86400` reaches neither, and must not put a full day's official
  // figure beside a single 5-minute reading.
  const official = fromRollups && resolution === 86400 ? await loadOfficialIndex(env, timestamps) : null;

  // NEM first, then regions ascending — reading order, and the dashboard default.
  const orderedRegions = [NEM_KEY, ...[...regions].filter((r) => r !== NEM_KEY).sort()];
  const series = orderedRegions.map((key) => {
    const values: (number | null)[] = [];
    const coverage: (number | null)[] = [];
    for (const t of timestamps) {
      const totals = byBucket.get(t)?.get(key);
      // No factored generation in the bucket is "no reading", never 0 gCO2/kWh.
      values.push(
        totals === undefined || totals.mwFactored <= 0 ? null : round4(totals.factorWeighted / totals.mwFactored),
      );
      coverage.push(totals === undefined || totals.mwTotal <= 0 ? null : round4(totals.mwFactored / totals.mwTotal));
    }
    const entry: Record<string, unknown> = { key, values, coverage };
    // Present on every daily response — an empty window yields an empty array,
    // never a missing field, so the shape does not depend on the data.
    if (official !== null) entry.official = timestamps.map((t) => official.get(`${t} ${key}`) ?? null);
    return entry;
  });

  return json({
    start: window.start ?? null,
    end: window.end ?? null,
    resolution,
    unit: 'tCO2-e/MWh',
    timestamps,
    series,
  });
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** AEMO's official daily index for the covered buckets, keyed `<bucket> <region>`. */
async function loadOfficialIndex(env: Env, timestamps: number[]): Promise<Map<string, number>> {
  // An empty window has no bucket range to bind (both binds would be NaN);
  // the caller still emits `[]`, as API.md documents.
  if (timestamps.length === 0) return new Map();
  const { results } = await env.DB.prepare(
    'SELECT settlement_date, region, intensity FROM cdeii_daily WHERE settlement_date >= ? AND settlement_date <= ?',
  )
    .bind(timestamps[0] - CDEII_DAY_SECONDS, timestamps[timestamps.length - 1] - CDEII_DAY_SECONDS)
    .all<{ settlement_date: number; region: string; intensity: number }>();
  return new Map(results.map((r) => [`${r.settlement_date + CDEII_DAY_SECONDS} ${r.region}`, r.intensity]));
}

async function handleGenerators(env: Env, params: URLSearchParams): Promise<Response> {
  const filters = generatorFilters(params);
  const where = filters.length > 0 ? ` WHERE ${filters.map((f) => f.sql).join(' AND ')}` : '';
  // Explicit projection, not SELECT * — the response shape is pinned in
  // API.md; future schema columns must not drift (or leak) into it silently.
  const { results } = await env.DB.prepare(
    'SELECT id, name, participant_name, duid, state, technology_type, ' +
      'technology_description, fuel_type, fuel_description, reg_cap, max_cap ' +
      `FROM generators${where} ORDER BY id`,
  )
    .bind(...filters.flatMap((f) => f.binds))
    .all();
  // Bare array, as the legacy endpoint returned.
  return json(results);
}

// ---------------------------------------------------------------------------
// Router

export async function handleApi(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'GET') return jsonError(405, 'method not allowed');

  const url = new URL(request.url);
  const route = url.pathname.replace(/\/+$/, '');

  try {
    switch (route) {
      case '/api/v2/values':
        return await handleValues(env, url.searchParams);
      case '/api/v2/values/aggregate':
        return await handleAggregate(env, url.searchParams);
      case '/api/v2/dispatch':
        return await handleDispatch(env, url.searchParams);
      case '/api/v2/rooftop':
        return await handleRooftop(env, url.searchParams);
      case '/api/v2/generators':
        return await handleGenerators(env, url.searchParams);
      case '/api/v2/intensity':
        return await handleIntensity(env, url.searchParams);
      default:
        return jsonError(
          404,
          'unknown route: available are /api/v2/values, /api/v2/values/aggregate, ' +
            '/api/v2/dispatch, /api/v2/rooftop, /api/v2/generators, /api/v2/intensity',
        );
    }
  } catch (err) {
    if (err instanceof ApiError) return jsonError(err.status, err.message);
    // Raw errors (including any SQL text) stay in the logs, never the response.
    console.error('api error:', err);
    return jsonError(500, 'internal error');
  }
}
