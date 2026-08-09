/* Page chrome shared by the fuel-mix chart (app.js) and the station map
 * (map.js) — the DOM plumbing that is identical on both and has no business
 * being maintained twice.
 *
 * This module deliberately contains NO Tailwind class names except `hidden`,
 * which both pages already emit. tailwind.css scans an allow-list rather than
 * the directory (see the comment there), so a shared module that introduced a
 * new class would either go missing on one page or inflate the other's bytes.
 * Keep it that way: logic here, classes in the page.
 */

/** The five NEM regions plus the NEM-wide default. Exactly five exist — WA and
 *  NT are separate grids (worker/API.md). */
export const REGIONS = [
  ['', 'NEM'], ['QLD1', 'QLD'], ['NSW1', 'NSW'],
  ['VIC1', 'VIC'], ['SA1', 'SA'], ['TAS1', 'TAS'],
];

/** NEM market time: AEST, UTC+10, never DST. Brisbane, never Sydney. */
export const TZ = 'Australia/Brisbane';

export const $ = (id) => document.getElementById(id);

/** Fetch JSON, surfacing the API's own `{ error }` message when it sends one.
 *  The URL rides along in the message because both pages fan several fetches
 *  into one Promise.all, where a bare "HTTP 404" names nothing. */
export async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).error ?? detail; } catch { /* non-JSON error body */ }
    throw new Error(`${url}: ${detail}`);
  }
  return res.json();
}

export function showError(message) {
  const text = $('error-text');
  const alert = $('error-alert');
  if (!text || !alert) {
    // A page missing the alert markup must not swallow the failure silently.
    console.error(message);
    return;
  }
  text.textContent = message;
  alert.classList.remove('hidden');
}

export function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/**
 * Wire the header's light/dark toggle, calling `onChange` after each switch.
 *
 * `onChange` is what differs between pages — the chart repaints a canvas, the
 * map recolours SVG fills — so it is the parameter and everything else is
 * shared. A valid `?theme=` is an explicit choice that wins at boot, so the
 * OS-preference listener must respect it exactly as it respects a saved
 * toggle; that rule is the reason this is worth sharing at all.
 */
export function installTheme(onChange) {
  const queryTheme = new URLSearchParams(location.search).get('theme');
  const queryExplicit = queryTheme === 'light' || queryTheme === 'dark';
  const toggle = $('theme-toggle');
  if (!toggle) return; // page ships no toggle — nothing to wire
  toggle.checked = currentTheme() === 'dark';

  toggle.addEventListener('change', () => {
    const theme = toggle.checked ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
    onChange();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    if (queryExplicit || localStorage.getItem('theme')) return;
    document.documentElement.dataset.theme = event.matches ? 'dark' : 'light';
    toggle.checked = event.matches;
    onChange();
  });
}
