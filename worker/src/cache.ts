// Caching layer for the public /api/v2 (LAB-768): canonical cache keys +
// dispatch-interval-aligned TTLs over the Workers Cache API. This is the
// public API's first line of defence against hot-loop consumers, and the D1
// load shed for everything else.
//
// WHY the store is caches.default and not cachekit (the LAB-768 goal is
// dogfooding cachekit): as of 2026-07-26 no installable cachekit release can
// run here. @cachekit-io/cachekit@0.1.4 — the first version with a Workers
// entrypoint — hard-depends on @cachekit-io/cachekit-core-wasm@0.1.1, which
// was never published to npm (E404), and dist/workers/runtime.js imports it
// unconditionally, so the bundle cannot build. 0.1.3 has no Workers entry at
// all, and the Cache-API/KV backends (cachekit-ts#81) are merged upstream but
// unreleased. The POLICY below (key canonicalisation + TTLs — the actual
// engineering) is store-agnostic; the store itself is isolated in
// cacheFetch/cachePut and deliberately mirrors cachekit's own CacheAPIBackend
// scheme (synthetic never-fetched URLs under an RFC 2606 .invalid host,
// Cache-Control max-age), so the cachekit swap is a mechanical change to
// those two functions once a working release ships.
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

import type { Env } from './index';
import {
  firstParam,
  GENERATOR_FILTERS,
  handleApi,
  RELATIVE_WINDOWS,
  resolveLimit,
  resolveOrder,
  resolveResolution,
  resolveTimeWindow,
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

// Bump to invalidate every existing entry on a key-format or policy change.
const KEY_VERSION = 'k1';

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
  /** Synthetic never-fetched URL (RFC 2606 .invalid host) keying caches.default. */
  key: string;
  ttl: number;
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
    } else if (route === '/api/v2/values' || route === '/api/v2/values/aggregate') {
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

      parts.push(`res=${resolveResolution(params, window, nowSeconds)}`);
      const { limit, offset } = resolveLimit(params);
      parts.push(`lim=${limit}`, `off=${offset}`, `ord=${resolveOrder(params)}`);
      parts.push(...filterParts(params));

      // Upper bound of the data the window can see (t = exact matches only).
      const upper =
        window.exact !== undefined && window.end !== undefined ? Math.min(window.exact, window.end) : (window.exact ?? window.end);
      // Closed = every sample the window can ever see has been ingested: the
      // interval containing `upper` has ended AND its ingest grace has passed.
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
  return {
    key: `https://nem-api-cache.invalid/${KEY_VERSION}/${encodeURIComponent(`${url.host}${route}?${parts.join('&')}`)}`,
    ttl,
  };
}

/**
 * Cache-fronted /api/v2: GET responses (200 only) are stored in
 * caches.default under the canonical key with `Cache-Control: max-age=<ttl>`
 * (which is also the browser policy — `x-cache-expires` lets hits rewrite
 * max-age down to the REMAINING lifetime so a client fetching just before the
 * boundary cannot hold a stale response past it). `x-cache: HIT|MISS` is the
 * dogfooding observability signal.
 */
export async function handleApiCached(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return handleApi(request, env);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const entry = buildCacheEntry(new URL(request.url), nowSeconds);
  if (entry === null || entry.ttl <= 0) return handleApi(request, env);

  const cached = await caches.default.match(entry.key);
  if (cached !== undefined) {
    const headers = new Headers(cached.headers);
    const expires = Number(headers.get('x-cache-expires'));
    const remaining = Number.isFinite(expires) ? Math.max(0, expires - nowSeconds) : 0;
    headers.set('cache-control', `public, max-age=${remaining}`);
    headers.set('x-cache', 'HIT');
    return new Response(cached.body, { status: cached.status, headers });
  }

  const response = await handleApi(request, env);
  if (response.status !== 200) return response; // errors are never cached

  const headers = new Headers(response.headers);
  headers.set('cache-control', `public, max-age=${entry.ttl}`);
  headers.set('x-cache-expires', String(nowSeconds + entry.ttl));
  try {
    await caches.default.put(entry.key, new Response(response.clone().body, { status: 200, headers }));
  } catch (err) {
    // A failed put must never fail the request — the data is already in hand.
    console.error('cache put failed:', err);
  }
  headers.set('x-cache', 'MISS');
  return new Response(response.body, { status: 200, headers });
}
