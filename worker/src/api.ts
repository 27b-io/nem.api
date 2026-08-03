// HTTP query API (LAB-418): /api/v2/values, /api/v2/values/aggregate,
// /api/v2/generators — a greenfields v2 contract over the D1 store. PUBLIC
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

const MAX_LIMIT = 300000;
const DEFAULT_WINDOW_SECONDS = 86400;
const RESOLUTIONS = [300, 1800, 3600, 86400];
// NEM market time is AEST (UTC+10, no DST). 36000 % res === 0 for every
// sub-daily resolution, so the offset only shifts daily bucket boundaries
// (to AEST midnight) — sub-daily buckets are unaffected by it.
const NEM_UTC_OFFSET_SECONDS = 36000;

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
 * Bucket width in seconds. Explicit `resolution` must be on the allowlist;
 * otherwise auto-picked from the window span so wide windows don't ship
 * 5-min-resolution payloads.
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
  if (window.exact !== undefined && window.start === undefined && window.end === undefined) return 300;
  const span = (window.end ?? nowSeconds) - (window.start ?? 0);
  if (span <= 3 * 86400) return 300;
  if (span <= 14 * 86400) return 1800;
  if (span <= 90 * 86400) return 3600;
  return 86400;
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

/**
 * Bucket label expression: period-ENDING (AEMO SETTLEMENTDATE convention — a
 * sample ending exactly on a boundary belongs to the bucket ending there),
 * aligned to NEM time. `resolution` is a server-validated allowlist member.
 */
function bucketExpr(column: string, resolution: number): string {
  return `((${column} + ${NEM_UTC_OFFSET_SECONDS + resolution - 1}) / ${resolution}) * ${resolution} - ${NEM_UTC_OFFSET_SECONDS}`;
}

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

  const where = [...timeClauses(window, 'sv.scrape_time'), ...generatorFilters(params, 'g.')];

  // Inner query: instantaneous NET total MW per (dispatch interval, group) —
  // negative values (storage charging, station load draw) sum through, per
  // the net convention in API.md. Generators with a NULL group value land in
  // the '' series rather than being dropped. Outer query: mean of those
  // totals per bucket — mean-of-sums, which stays correct when a generator
  // misses an interval inside the bucket.
  const sql =
    `SELECT ${bucketExpr('t', resolution)} AS bucket, grp, ROUND(AVG(total), 4) AS value FROM (` +
    `SELECT sv.scrape_time AS t, COALESCE(g.${groupColumn}, '') AS grp, SUM(sv.value) AS total ` +
    'FROM scada_values sv JOIN generators g ON g.id = sv.generator_id ' +
    `WHERE ${where.map((c) => c.sql).join(' AND ')} ` +
    'GROUP BY t, grp' +
    ') GROUP BY bucket, grp ORDER BY bucket ASC, grp ASC LIMIT ? OFFSET ?';
  const binds = [...where.flatMap((c) => c.binds), limit, offset];

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
      case '/api/v2/generators':
        return await handleGenerators(env, url.searchParams);
      default:
        return jsonError(404, 'unknown route: available are /api/v2/values, /api/v2/values/aggregate, /api/v2/generators');
    }
  } catch (err) {
    if (err instanceof ApiError) return jsonError(err.status, err.message);
    // Raw errors (including any SQL text) stay in the logs, never the response.
    console.error('api error:', err);
    return jsonError(500, 'internal error');
  }
}
