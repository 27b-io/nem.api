// Caching layer for the public /api/v2 (LAB-768): canonical cache keys +
// dispatch-interval-aligned TTLs, stored through cachekit (the point of the
// ticket is dogfooding it as a real production consumer). This is the public
// API's first line of defence against hot-loop consumers, and the D1 load
// shed for everything else.
//
// Store: `createCache.minimal({ backend: workersCacheAPI() })` — minimal is
// cachekit's speed-first intent, documented for exactly this workload
// (read-heavy public APIs); the Cache API backend is a per-colo
// point-of-presence tier, which is the right shape here because the
// authoritative copy is D1 itself and every entry is re-derivable. No
// encryption/compression/SaaS tier on this pass (ticket non-goals).
//
// Key properties (also the abuse posture):
// - Canonical keys: alias params collapse onto their canonical name and time
//   values normalise to unix seconds via the SAME resolution functions the
//   handlers use (imported from ./api), so `region=` vs `state=` or ISO vs
//   unix cannot double-cache.
// - Unrecognised params are IGNORED in the key: `?junk=<random>` maps to the
//   canonical entry instead of busting through to D1.
// - Relative/now-derived windows (`hours=24`, the 24 h default) keep their
//   RELATIVE form in the key — resolving them would mint a new key every
//   second and never hit — and expire on the dispatch boundary, refilling
//   under the same key.
// - No stale-data footgun: any window that can still gain samples is cached
//   only to the current interval boundary, and entries created within the
//   post-boundary ingest grace window expire early (the */5 ingest cron lands
//   seconds AFTER the boundary — a dashboard polling exactly on the boundary
//   must not pin a pre-ingest response for the whole interval).

import { createCache, workersCacheAPI, type WorkersCache } from '@cachekit-io/cachekit/workers';
import type { Env } from './index';
import { nemBucket } from './rollups';
import {
  CORS_HEADERS,
  firstParam,
  GENERATOR_FILTERS,
  handleApi,
  RELATIVE_WINDOWS,
  resolveLimit,
  resolveOrder,
  resolveResolution,
  resolveTimeWindow,
  servedFromRollups,
} from './api';

export const DISPATCH_INTERVAL_SECONDS = 300;
// ponytail: fixed grace covering ingest lag after each */5 boundary; raise if
// wrangler tail shows NEMWEB fetch+insert regularly exceeding it.
export const INGEST_GRACE_SECONDS = 60;
// Fully-past windows are immutable per the dispatch model, but the ARCHIVE
// backfill (LAB-420) heals >2-day-old gaps — an infinite TTL would pin a gap
// response past its heal. One day keeps D1 at one query per unique historical
// URL per day while heals still surface.
export const CLOSED_WINDOW_TTL_SECONDS = 86400;
// generators only changes via the LAB-421 registration refresh, which writes
// D1 out-of-band (wrangler d1 execute) — no invalidation hook exists, so a
// modest TTL is the honest policy for reference data that moves ~weekly.
export const GENERATORS_TTL_SECONDS = 3600;

// Bump to invalidate every existing entry on a key-format, CachedResponse
// shape, or policy change — get<CachedResponse> is a blind cast, so a shape
// change without a bump would deserialize stale entries with missing fields.
// k2: LAB-1696 changed aggregate values at resolution 3600/86400 (rollup
// path: full-bucket edge semantics, global-denominator means) — pre-rollup
// entries must not survive the cutover.
const KEY_VERSION = 'k2';

/**
 * Seconds until this entry must expire so it never outlives the data:
 * normally the next dispatch boundary; within the ingest grace window after a
 * boundary, only to the end of that grace (the interval's sample may not have
 * landed yet, so a just-filled entry gets retried at boundary+grace).
 */
export function boundaryTtl(nowSeconds: number): number {
  const lastBoundary = Math.floor(nowSeconds / DISPATCH_INTERVAL_SECONDS) * DISPATCH_INTERVAL_SECONDS;
  if (nowSeconds < lastBoundary + INGEST_GRACE_SECONDS) return lastBoundary + INGEST_GRACE_SECONDS - nowSeconds;
  return lastBoundary + DISPATCH_INTERVAL_SECONDS - nowSeconds;
}

interface CacheEntry {
  /** Canonical cachekit key (the backend maps it to storage injectively). */
  key: string;
  ttl: number;
}

// One cache per isolate, per the SDK's own guidance — per-request creation
// leaks wasm allocations on hot isolates. Lazy so module init stays
// side-effect-free. Exported for tests (they must exercise THIS configured
// instance — the options below are load-bearing policy, see each line).
let cache: WorkersCache | null = null;

export function cacheInstance(): WorkersCache {
  cache ??= createCache.minimal({
    backend: workersCacheAPI(),
    // Ticket non-goal, and the values are served-as-is JSON — skip the wasm
    // ByteStorage envelope (cachekit defaults compression ON).
    compression: false,
    // cachekit's L1 would repopulate on an L2 hit with ITS default TTL
    // (cache-core get(): ttlSeconds ?? defaultTtl), not the entry's remaining
    // lifetime — an isolate could serve a boundary-TTL entry past the
    // dispatch boundary. The Cache API backend is already colo-local, so L1
    // buys nothing here but that staleness (plus multi-MB bodies in isolate
    // memory). Off.
    l1: { enabled: false },
    // /api/v2 bodies are multi-MB at the default 300000-row limit; cachekit's
    // 1 MiB encode default would throw ValueTooLargeError on exactly the
    // heaviest queries — caught and logged, but silently never cached.
    // 64 MiB covers realistic maxima; anything larger falls through uncached.
    serializer: { maxEncodedSize: 64 * 1024 * 1024, maxDecodedSize: 64 * 1024 * 1024 },
  });
  return cache;
}

/** What we cache: the serialized 200 body plus its absolute expiry. */
interface CachedResponse {
  body: string;
  expires: number;
}

/**
 * Response headers rebuilt on both paths: the handler's own CORS + JSON
 * headers, Cache-Control carrying the REMAINING lifetime (so a client
 * fetching just before the boundary cannot hold a stale response past it),
 * `x-cache-expires` (unix), and the HIT/MISS dogfooding signal.
 */
function responseHeaders(maxAge: number, expires: number, xCache: 'HIT' | 'MISS'): Headers {
  const headers = new Headers(CORS_HEADERS);
  headers.set('content-type', 'application/json');
  headers.set('cache-control', `public, max-age=${maxAge}`);
  headers.set('x-cache-expires', String(expires));
  headers.set('x-cache', xCache);
  return headers;
}

/** Canonical generator-filter key parts; comma lists sort (IN() is unordered). */
function filterParts(params: URLSearchParams): string[] {
  const parts: string[] = [];
  for (const { column, aliases } of GENERATOR_FILTERS) {
    const raw = firstParam(params, aliases);
    if (raw === undefined) continue;
    const value = raw.includes(',')
      ? raw
          .split(',')
          .filter((s) => s !== '')
          .sort()
          .join(',')
      : raw;
    parts.push(`${column}=${value}`);
  }
  return parts;
}

/**
 * Canonical key + TTL for a /api/v2 GET, or null for anything this layer
 * won't cache (unknown routes, malformed params — the handler owns the 400).
 *
 * Windows resolve twice with `now` one second apart: identical results mean
 * the window is absolute (cache long once its upper bound is safely past);
 * differing results mean it is now-derived, so the key keeps the relative
 * param form and the entry expires on the dispatch boundary.
 */
export function buildCacheEntry(url: URL, nowSeconds: number): CacheEntry | null {
  const route = url.pathname.replace(/\/+$/, '');
  const params = url.searchParams;
  const parts: string[] = [];
  let ttl: number;

  try {
    if (route === '/api/v2/generators') {
      parts.push(...filterParts(params));
      ttl = GENERATORS_TTL_SECONDS;
    } else if (route === '/api/v2/values' || route === '/api/v2/values/aggregate' || route === '/api/v2/intensity') {
      if (route === '/api/v2/values/aggregate') {
        // group_by is echoed verbatim in the body, so `region` and its
        // storage alias `state` are distinct responses — no collapsing here.
        parts.push(`group_by=${firstParam(params, ['group_by']) ?? ''}`);
      }

      const window = resolveTimeWindow(params, nowSeconds);
      const shifted = resolveTimeWindow(params, nowSeconds + 1);
      const nowDerived = window.start !== shifted.start || window.end !== shifted.end || window.exact !== shifted.exact;

      if (nowDerived) {
        const relative = RELATIVE_WINDOWS.map(([name]) => name)
          .map((name) => {
            const raw = firstParam(params, [name]);
            return raw === undefined ? undefined : `${name}:${raw}`;
          })
          .find((v) => v !== undefined);
        parts.push(`rel=${relative ?? 'default'}`);
      } else {
        if (window.exact !== undefined) parts.push(`t=${window.exact}`);
        if (window.start !== undefined) parts.push(`ts=${window.start}`);
        if (window.end !== undefined) parts.push(`te=${window.end}`);
      }

      const resolution = resolveResolution(params, window, nowSeconds);
      parts.push(`res=${resolution}`);
      // intensity reads none of limit/offset/sort/generator-filters — it is
      // defined per region, always returns every region, and is bounded by its
      // resolution floor instead. For that route these are unrecognised params
      // and stay out of the key like any other, so `?limit=5` cannot mint a
      // second entry for a byte-identical response.
      if (route !== '/api/v2/intensity') {
        const { limit, offset } = resolveLimit(params);
        parts.push(`lim=${limit}`, `off=${offset}`, `ord=${resolveOrder(params)}`, ...filterParts(params));
      }

      // Upper bound of the data the window can see (t = exact matches only).
      let upper =
        window.exact !== undefined && window.end !== undefined ? Math.min(window.exact, window.end) : (window.exact ?? window.end);
      // Rollup-served responses (LAB-1696 aggregate, LAB-1698 intensity)
      // return the FULL bucket straddling `time_end`, so the response keeps
      // changing until that bucket completes — the closed test must clear the
      // bucket end, not just `time_end`. `/values` is raw at every resolution
      // and clips to the window, so it is excluded by route, but the ROUTING
      // condition itself comes from api.ts so it cannot drift here.
      if (upper !== undefined && route !== '/api/v2/values' && servedFromRollups(window, resolution)) {
        upper = nemBucket(upper, resolution);
      }
      // Closed = every sample the response can ever reflect has been
      // ingested: the interval containing `upper` has ended AND its ingest
      // grace has passed.
      const closed =
        !nowDerived &&
        upper !== undefined &&
        nowSeconds >= Math.ceil(upper / DISPATCH_INTERVAL_SECONDS) * DISPATCH_INTERVAL_SECONDS + INGEST_GRACE_SECONDS;
      ttl = closed ? CLOSED_WINDOW_TTL_SECONDS : boundaryTtl(nowSeconds);
    } else {
      return null;
    }
  } catch {
    // Malformed params: pass through so the handler's 400 (never cached) wins.
    return null;
  }

  // Host included so multiple public surfaces (workers.dev, nem.27b.io) never
  // share entries; tests rely on this for isolation of the shared test cache.
  return { key: `${KEY_VERSION}:${url.host}${route}?${parts.join('&')}`, ttl };
}

/**
 * Cache-fronted /api/v2: GET 200 bodies are stored through cachekit under
 * the canonical key with the policy TTL. Cache failures in either direction
 * are logged and the request proceeds — the cache layer must never be the
 * reason a public request fails.
 */
export async function handleApiCached(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return handleApi(request, env);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const entry = buildCacheEntry(new URL(request.url), nowSeconds);
  if (entry === null || entry.ttl <= 0) return handleApi(request, env);

  let hit: CachedResponse | null = null;
  try {
    hit = await cacheInstance().get<CachedResponse>(entry.key);
  } catch (err) {
    console.error(`cache get failed (${entry.key}):`, err);
  }
  if (hit !== null) {
    return new Response(hit.body, {
      status: 200,
      headers: responseHeaders(Math.max(0, hit.expires - nowSeconds), hit.expires, 'HIT'),
    });
  }

  const response = await handleApi(request, env);
  if (response.status !== 200) return response; // errors are never cached

  const body = await response.text();
  const expires = nowSeconds + entry.ttl;
  try {
    await cacheInstance().set<CachedResponse>(entry.key, { body, expires }, { ttl: entry.ttl });
  } catch (err) {
    // A failed set must never fail the request — the data is already in hand.
    console.error(`cache set failed (${entry.key}):`, err);
  }
  return new Response(body, { status: 200, headers: responseHeaders(entry.ttl, expires, 'MISS') });
}
