/* Time-range selector logic for the dashboard (LAB-1697) — pure, no DOM, so
 * test/ranges.spec.ts can exercise it directly.
 *
 * Each range maps to a relative-window query param (worker/API.md); no
 * `resolution` is ever sent — the API auto-steps bucket width by window span
 * (≤3d → 5-min, ≤14d → 30-min, ≤90d → hourly, else daily). "All" is the full
 * 13-month D1 retention window. */

// `days` ≈ the window's span in days — weather.js uses it to pick an
// Open-Meteo endpoint. Approximate is fine there (a day either way just
// shifts the archive window edge, never breaks the query), but it lives HERE
// so a new range can't be added without declaring its weather window.
export const RANGES = [
  { key: '24h', label: '24H', query: 'hours=24', days: 1 },
  { key: '3d',  label: '3D',  query: 'days=3',   days: 3 },
  { key: '7d',  label: '7D',  query: 'days=7',   days: 7 },
  { key: '30d', label: '30D', query: 'days=30',  days: 30 },
  { key: '1y',  label: '1Y',  query: 'months=12', days: 366 },
  { key: 'all', label: 'All', query: 'months=13', days: 396 },
];

// Single source of truth: the default is whatever leads the table, and
// rangeQuery falls back to the same entry for unknown keys.
export const DEFAULT_RANGE = RANGES[0].key;

export function rangeQuery(key) {
  return (RANGES.find((r) => r.key === key) ?? RANGES[0]).query;
}

/* Bucket-width noun for the readout, from the `resolution` the API says it
 * actually served — a daily bucket must never claim a 5-minute interval. */
export function bucketLabel(resolution) {
  if (!Number.isFinite(resolution)) return 'Interval';
  if (resolution >= 86400) return 'Day';
  if (resolution >= 3600) return 'Hour';
  if (resolution >= 1800) return '30-min interval';
  return '5-min interval';
}
