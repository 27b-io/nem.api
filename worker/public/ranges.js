/* Time-range selector for the LAB-419 dashboard (LAB-1697). Pure — no DOM —
 * so test/ranges.spec.ts can exercise it directly.
 *
 * Params map straight onto worker/API.md's relative-window params
 * (hours/days/months); resolution is intentionally never sent — the API
 * auto-steps it by window span. */

export const DEFAULT_RANGE = '24h';

export const RANGES = [
  ['24h', '24H', { hours: 24 }],
  ['3d', '3D', { days: 3 }],
  ['7d', '7D', { days: 7 }],
  ['30d', '30D', { days: 30 }],
  ['1y', '1Y', { months: 12 }],
  ['all', 'All', { months: 13 }], // full 13-month retention
];

export function isRange(value) {
  return RANGES.some(([v]) => v === value);
}

export function rangeParams(value) {
  const found = RANGES.find(([v]) => v === value) ?? RANGES.find(([v]) => v === DEFAULT_RANGE);
  return found[2];
}

// worker/API.md resolution auto-step: ≤3d→300, ≤14d→1800, ≤90d→3600, else 86400.
// The readout borrows the same thresholds so its wording never claims a
// finer bucket than the response actually contains.
export function bucketLabel(resolutionSeconds) {
  if (resolutionSeconds <= 300) return '5-min interval';
  if (resolutionSeconds <= 1800) return '30-min interval';
  if (resolutionSeconds <= 3600) return 'Hourly interval';
  return 'Daily interval';
}
