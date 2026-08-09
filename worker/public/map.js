/* NEM power-station map (LAB-1702).
 *
 * Three sources meet here and each stays in its lane:
 *   /basemap.json          jurisdiction outlines (Natural Earth, public domain)
 *   /facilities.json       DUID -> coordinates + links (Open Electricity, CC BY-NC)
 *   /api/v2/generators     the registration truth: name, fuel, capacity, region,
 *                          and the AEMO CDEII emission factor
 *   /api/v2/values?duid=…  live dispatch for the station you clicked
 *
 * The join is in stations.js (pure, unit-tested); this file is the DOM.
 *
 * WHY no map library and no tile server: the whole basemap is 2100 vertices of
 * vendored public-domain geometry, which themes with a CSS variable, ships from
 * our own origin like every other asset here, and answers the tile-ToS question
 * by not asking it. Raster tiles would need a CSS inversion hack to survive
 * dark mode and a third-party request on every page view. Pan/zoom over an SVG
 * viewBox is ~40 lines; Leaflet is 140 kB to save them.
 */
import { $, fetchJson, installTheme, REGIONS, showError, TZ } from './chrome.js';
import { FUEL_SLOTS, fuelColor } from './stacking.js';
import { emissionsRate, facilityOutput, joinStations, markerRadius, mercator, sparkPath } from './stations.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LABEL_PX = 13; // jurisdiction label size, in screen pixels
const DISPATCH_INTERVAL = 300; // seconds; the NEM dispatch cadence
const FRAME_MARGIN = 0.06; // breathing room around a framed region
// Marker floor in screen pixels. Not a scale point — a 20 kW rooftop array and
// a 2.9 GW coal station both have to be hittable, and a 3 px dot is not: it is
// a 6 px target, under half the ~24 px a pointer can reliably acquire.
const MIN_MARKER_PX = 4.5;

const fmtMW = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 });
const fmtMW1 = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 1 });
const fmtFactor = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 3 });
// Emissions rates span a landfill unit's fraction of a tonne per hour to a coal
// station's two thousand; significant digits keep both readable, and keep the
// small one from rounding to a zero we explicitly promise not to report.
const fmtRate = new Intl.NumberFormat('en-AU', { maximumSignificantDigits: 3 });
const fmtWhen = new Intl.DateTimeFormat('en-AU', {
  timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

const svg = $('map');

const state = {
  region: '',
  stations: [],
  byCode: new Map(),
  markers: new Map(),
  labels: [],
  selected: null,
  view: null,
  home: null,
  bounds: null,
  detailToken: 0,
};

/* ---------------------------------------------------------------- utilities */

/** Minimal element builder. Text goes through textContent, never innerHTML —
 *  station names and link URLs come from a third-party dump, so the panel is
 *  injection-proof by construction rather than by remembering to escape. */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

/** http(s) only. The dump's link fields are third-party data; a `javascript:`
 *  URL in one of them must not become a clickable link on our origin. */
function safeUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ basemap */

function ringPath(ring) {
  let d = '';
  for (let i = 0; i < ring.length; i += 2) {
    const { x, y } = mercator(ring[i], ring[i + 1]);
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(3)} ${y.toFixed(3)}`;
  }
  return `${d}Z`;
}

function ringBounds(rings) {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      const { x, y } = mercator(ring[i], ring[i + 1]);
      box.minX = Math.min(box.minX, x);
      box.maxX = Math.max(box.maxX, x);
      box.minY = Math.min(box.minY, y);
      box.maxY = Math.max(box.maxY, y);
    }
  }
  return box;
}

/** A view box that frames `bounds` at `aspect`, with a margin around it.
 *  The aspect is passed in rather than read off state.home, because the first
 *  call is the one that PRODUCES state.home. */
function frame(bounds, aspect) {
  const margin = FRAME_MARGIN;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  let w = (bounds.maxX - bounds.minX) * (1 + margin * 2);
  let h = (bounds.maxY - bounds.minY) * (1 + margin * 2);
  // Grow the short side so the framing never distorts the projection.
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** The map box's aspect, from real layout. clientToUser assumes the viewBox
 *  aspect matches it exactly — any mismatch and preserveAspectRatio letterboxes,
 *  which silently offsets every coordinate the pointer produces. So the box is
 *  sized by CSS and the viewBox is fitted to IT, never the other way round. */
function boxAspect() {
  // Floors would DEFEAT the point: `height: min(62vh, 34rem)` renders under
  // 240 px on a viewport shorter than ~387 px (a landscape phone), and a
  // floored height computes an aspect the element does not have — which is
  // exactly the letterboxing this function exists to prevent. Only a zero
  // dimension (no layout yet) gets a fallback, and 4/3 is just something
  // finite to survive on until the resize listener supplies the truth.
  const { clientWidth: w, clientHeight: h } = svg;
  return w > 0 && h > 0 ? w / h : 4 / 3;
}

function renderBasemap(basemap) {
  state.bounds = ringBounds(basemap.regions.flatMap((r) => r.rings));
  state.home = frame(state.bounds, boxAspect());

  const land = document.createElementNS(SVG_NS, 'g');
  const labels = document.createElementNS(SVG_NS, 'g');
  for (const region of basemap.regions) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', region.rings.map(ringPath).join(''));
    path.setAttribute('class', region.id ? 'region' : 'region outside-nem');
    path.append(titleNode(region.id ? `${region.label} (${region.id})` : `${region.label} — not in the NEM`));
    land.append(path);

    // Anchor the label on the largest ring's centre, not the jurisdiction's:
    // Queensland's bounding box includes its islands and would put "QLD" in
    // the Coral Sea.
    const largest = region.rings.reduce((a, r) => (r.length > a.length ? r : a));
    const box = ringBounds([largest]);
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('class', 'region-label');
    text.setAttribute('x', String((box.minX + box.maxX) / 2));
    text.setAttribute('y', String((box.minY + box.maxY) / 2));
    text.textContent = region.label;
    labels.append(text);
    state.labels.push(text);
  }
  svg.append(land, labels);
}

function titleNode(text) {
  const node = document.createElementNS(SVG_NS, 'title');
  node.textContent = text;
  return node;
}

/* ------------------------------------------------------------------ markers */

function renderMarkers() {
  const group = document.createElementNS(SVG_NS, 'g');
  const maxCapacity = Math.max(...state.stations.map((s) => s.capacity), 1);
  // Biggest first so small stations paint on top and stay clickable — a 20 MW
  // landfill unit inside a coal station's marker is otherwise unreachable.
  for (const station of [...state.stations].sort((a, b) => b.capacity - a.capacity)) {
    const { x, y } = mercator(station.lng, station.lat);
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', x.toFixed(4));
    circle.setAttribute('cy', y.toFixed(4));
    circle.setAttribute('class', 'marker');
    circle.dataset.px = String(markerRadius(station.capacity, maxCapacity, MIN_MARKER_PX));
    circle.dataset.code = station.code;
    circle.append(titleNode(`${station.name} — ${fmtMW.format(station.capacity)} MW ${station.fuel || 'unspecified'}`));
    circle.addEventListener('click', () => select(station.code));
    group.append(circle);
    state.markers.set(station.code, circle);
  }
  svg.append(group);
  paintMarkers();
}

/** Fuel colours and region dimming both live here so a theme flip and a region
 *  click take the same path. */
function paintMarkers() {
  const dark = document.documentElement.dataset.theme === 'dark';
  for (const station of state.stations) {
    const marker = state.markers.get(station.code);
    marker.setAttribute('fill', fuelColor(station.fuel)[dark ? 'dark' : 'light']);
    marker.classList.toggle('dimmed', state.region !== '' && station.region !== state.region);
    marker.classList.toggle('selected', state.selected === station.code);
  }
}

/** Marker radii AND jurisdiction label type are specified in SCREEN PIXELS,
 *  but SVG presentation attributes are in user units — at this viewBox a `10px` label
 *  renders about 150 px tall and swallows the continent. Both are converted on
 *  every view change, which is also what keeps a pin a pin at any zoom. */
function rescaleToScreenPixels() {
  // Floored at the narrowest real viewport. Unlike boxAspect() above, a floor
  // is safe here: this is a per-marker SIZE, not a ratio the viewBox has to
  // match, so a slightly-too-small pin on a 200 px viewport is cosmetic where a
  // wrong aspect would misplace every click. A zero means no layout yet
  // (background tab, hidden container, headless engine) and dividing by it
  // scales every marker by most of the viewBox and paints the map solid.
  const width = Math.max(svg.clientWidth, 320);
  const k = state.view.w / width;
  for (const marker of state.markers.values()) {
    marker.setAttribute('r', (Number(marker.dataset.px) * k).toFixed(4));
  }
  for (const label of state.labels) {
    label.setAttribute('font-size', (LABEL_PX * k).toFixed(4));
    // The halo that keeps a label legible over a marker, also in pixels.
    label.setAttribute('stroke-width', (3 * k).toFixed(4));
  }
}

/** Keep the viewport's centre inside the continent. Without this a stray drag
 *  leaves you looking at empty ocean with no cue about which way home is. */
function clampView(view) {
  const home = state.home;
  const cx = Math.min(home.x + home.w, Math.max(home.x, view.x + view.w / 2));
  const cy = Math.min(home.y + home.h, Math.max(home.y, view.y + view.h / 2));
  return { ...view, x: cx - view.w / 2, y: cy - view.h / 2 };
}

/** Re-fit the whole-NEM view to the current box and correct the live view's
 *  aspect so it keeps matching. Runs on resize.
 *
 *  The visitor's position is ALWAYS preserved — there is no "they were only
 *  panned, so recentring is harmless" case. Someone who dragged to Tasmania at
 *  full zoom-out has a view whose width still equals home's; snapping that back
 *  to the centred continent on an orientation change throws away the only thing
 *  they had done. Centre and width survive, only the height follows the new
 *  aspect, and clampView keeps the result on the map. */
function reframe() {
  if (!state.bounds || !state.view) return;
  const aspect = boxAspect();
  state.home = frame(state.bounds, aspect);
  const cx = state.view.x + state.view.w / 2;
  const cy = state.view.y + state.view.h / 2;
  // A narrower box can make the old width wider than the whole-NEM view.
  const w = Math.min(state.view.w, state.home.w);
  const h = w / aspect;
  setView(clampView({ x: cx - w / 2, y: cy - h / 2, w, h }));
}

function setView(view) {
  // A non-finite box paints a blank page rather than throwing, which is the
  // worst way for a geometry mistake to present — it looks like a data
  // problem. Fall back to the whole-NEM view and say so in the console.
  if (![view.x, view.y, view.w, view.h].every(Number.isFinite)) {
    console.error('station map: refusing a non-finite viewBox, falling back to the NEM view', view);
    view = state.home;
  }
  state.view = view;
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  rescaleToScreenPixels();
}

/* --------------------------------------------------------------- pan / zoom */

function clientToUser(clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  return {
    x: state.view.x + ((clientX - rect.left) / rect.width) * state.view.w,
    y: state.view.y + ((clientY - rect.top) / rect.height) * state.view.h,
  };
}

/** Zoom by `factor` about a user-space anchor, or about the view's centre. */
function zoomBy(factor, anchor = null) {
  // Never zoom out past the whole-NEM view; 60x in is about a suburb.
  const w = Math.min(state.home.w, Math.max(state.home.w / 60, state.view.w * factor));
  const scale = w / state.view.w;
  const at = anchor ?? { x: state.view.x + state.view.w / 2, y: state.view.y + state.view.h / 2 };
  setView(clampView({
    x: at.x - (at.x - state.view.x) * scale,
    y: at.y - (at.y - state.view.y) * scale,
    w,
    h: state.view.h * scale,
  }));
}

function installPanZoom() {
  // Plain wheel zooms — no modifier. An earlier revision required ctrl/⌘ to
  // avoid swallowing page scroll, which Ray reported as painful, and he was
  // right: no map on the web works that way. The scroll-trap it was guarding
  // against is instead handled where it belongs, in CSS — the map is capped to
  // a fraction of the viewport height (map.css), so there is always page above
  // and below it to put the cursor on. The +/− buttons and double-click below
  // mean the wheel is never the only way in.
  svg.addEventListener('wheel', (event) => {
    event.preventDefault();
    // Continuous in deltaY so a trackpad's fine-grained events feel smooth and
    // a mouse notch still moves a useful amount.
    zoomBy(Math.exp(event.deltaY * 0.0015), clientToUser(event.clientX, event.clientY));
  }, { passive: false });

  /* Double-click zooms the BASEMAP only.
   *
   * Over a marker it does nothing: a pin is a target, and hitting it twice
   * must not also move the map out from under the panel that just opened.
   * Kody's suggested fix — setting suppressClick inside this handler — cannot
   * work: the browser fires click, click, THEN dblclick, so both clicks have
   * already been delivered by the time this runs and the flag would instead
   * eat the next unrelated click. The second click is stopped by its own
   * `detail` below, which is the only signal available while it is in flight. */
  svg.addEventListener('dblclick', (event) => {
    event.preventDefault();
    if (event.target.classList.contains('marker')) return;
    zoomBy(event.shiftKey ? 2 : 0.5, clientToUser(event.clientX, event.clientY));
  });

  /* Drag to pan.
   *
   * NO setPointerCapture here, deliberately. Capturing the pointer on the SVG
   * retargets the subsequent `pointerup` AND `click` to the SVG itself, so a
   * marker's own click listener never fires — which is exactly the bug Ray hit
   * ("clicking on a station should show its details"). Verified with real
   * pointer events: pointerdown arrived at the circle, click arrived at the
   * svg. Capture only existed so a drag continuing outside the map kept
   * panning; window-level move/up listeners buy the same thing without
   * touching event targeting.
   */
  let dragging = null;
  // Set on pointerup when the pointer genuinely moved, consumed by the click
  // the browser fires straight afterwards — a drag that happens to end over a
  // marker must not also open that station. Cleared on the next pointerdown so
  // a drag that produces no click cannot eat an unrelated later one.
  let suppressClick = false;

  svg.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return; // left button only; right-click is the menu
    suppressClick = false;
    dragging = { id: event.pointerId, clientX: event.clientX, clientY: event.clientY, moved: false };
    svg.classList.add('dragging');
  });

  // In CSS PIXELS, not user units. The old threshold was 0.2% of the viewBox
  // width, which at the whole-NEM view is under two pixels — so the hand
  // tremor in an ordinary click registered as a drag and the click was
  // suppressed. 4 px is the conventional slop.
  const DRAG_SLOP_PX = 4;

  addEventListener('pointermove', (event) => {
    if (!dragging || event.pointerId !== dragging.id) return;
    if (Math.hypot(event.clientX - dragging.clientX, event.clientY - dragging.clientY) > DRAG_SLOP_PX) {
      dragging.moved = true;
    }
    if (!dragging.moved) return; // don't nudge the view for a click's jitter
    const rect = svg.getBoundingClientRect();
    const dx = ((event.clientX - dragging.clientX) / rect.width) * state.view.w;
    const dy = ((event.clientY - dragging.clientY) / rect.height) * state.view.h;
    dragging.clientX = event.clientX;
    dragging.clientY = event.clientY;
    setView(clampView({ ...state.view, x: state.view.x - dx, y: state.view.y - dy }));
  });

  const endDrag = (event) => {
    if (!dragging || event.pointerId !== dragging.id) return;
    svg.classList.remove('dragging');
    suppressClick = dragging.moved;
    dragging = null;
  };
  addEventListener('pointerup', endDrag);
  addEventListener('pointercancel', endDrag);
  svg.addEventListener('click', (event) => {
    // detail > 1 is the second (or later) click of a multi-click. Letting it
    // through would re-select the station and fire its 24-hour fetch a second
    // time for one gesture.
    if (event.detail > 1) {
      event.stopPropagation();
      return;
    }
    if (!suppressClick) return;
    suppressClick = false;
    event.stopPropagation();
  }, true);

  // Visible controls: the discoverable, keyboard-reachable way to zoom.
  $('zoom-in').addEventListener('click', () => zoomBy(0.5));
  $('zoom-out').addEventListener('click', () => zoomBy(2));
  $('reset-view').addEventListener('click', () => setRegion(''));
}

/* ------------------------------------------------------------------ chrome */

function renderRegionFilter() {
  const nav = $('region-filter');
  nav.textContent = '';
  for (const [id, label] of REGIONS) {
    const button = el('button', {
      class: `btn btn-sm join-item${state.region === id ? ' btn-active' : ''}`,
      type: 'button',
      text: label,
      'aria-pressed': String(state.region === id),
    });
    button.addEventListener('click', () => setRegion(id));
    nav.append(button);
  }
}

/** Select a region ('' = the whole NEM) and frame it. The one place region
 *  state changes, so the buttons, the reset control and a `?region=` deep link
 *  cannot drift into three slightly different behaviours. */
function setRegion(id) {
  state.region = id;
  renderRegionFilter();
  paintMarkers();
  const bounds = id ? regionBounds(id) : null;
  setView(bounds ? frame(bounds, state.home.w / state.home.h) : state.home);
  syncUrl();
}

/** Frame a region on its own stations, not its border: the point of zooming to
 *  South Australia is to separate the pins, and half of SA has none. Returns
 *  null when the region has none at all, which the caller renders as the
 *  whole-NEM view rather than as a viewBox full of NaN. */
function regionBounds(region) {
  const points = state.stations.filter((s) => s.region === region).map((s) => mercator(s.lng, s.lat));
  if (points.length === 0) return null;
  return {
    minX: Math.min(...points.map((p) => p.x)), maxX: Math.max(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)), maxY: Math.max(...points.map((p) => p.y)),
  };
}

function renderLegend() {
  const present = new Set(state.stations.map((s) => s.fuel));
  const known = FUEL_SLOTS.filter((f) => present.has(f.key)).map((f) => [f.key, f.label]);
  const others = [...present].filter((k) => !FUEL_SLOTS.some((f) => f.key === k)).sort();
  const dark = document.documentElement.dataset.theme === 'dark';
  const legend = $('legend');
  legend.textContent = '';
  for (const [key, label] of [...known, ...others.map((k) => [k, k === '' ? 'Unspecified' : k])]) {
    const swatch = el('span', { class: 'swatch' });
    swatch.style.backgroundColor = fuelColor(key)[dark ? 'dark' : 'light'];
    legend.append(el('span', { class: 'text-base-content/70' }, [swatch, document.createTextNode(label)]));
  }
}

function renderStationSelect() {
  const picker = $('station-select');
  picker.textContent = '';
  picker.append(el('option', { value: '', text: 'Choose a station…' }));
  for (const station of [...state.stations].sort((a, b) => a.name.localeCompare(b.name))) {
    picker.append(el('option', { value: station.code, text: `${station.name} — ${station.region}` }));
  }
  picker.addEventListener('change', () => { if (picker.value) select(picker.value); });
}

function syncUrl() {
  const params = new URLSearchParams();
  if (state.region) params.set('region', state.region);
  if (state.selected) params.set('station', state.selected);
  const query = params.toString();
  history.replaceState(null, '', query ? `?${query}` : location.pathname);
}

/* --------------------------------------------------------------- drill-down */

function select(code) {
  const station = state.byCode.get(code);
  if (!station) return;
  state.selected = code;
  $('station-select').value = code;
  paintMarkers();
  syncUrl();
  renderPanel(station);
}

function renderPanel(station) {
  const token = ++state.detailToken;
  const body = $('panel-body');
  body.textContent = '';

  const wikipedia = safeUrl(station.wikipedia);
  const website = safeUrl(station.website);
  const participants = [...new Set(station.units.map((u) => u.participant_name).filter(Boolean))];
  const techs = [...new Set(station.units.map((u) => u.technology_description || u.technology_type).filter(Boolean))];

  body.append(
    el('div', {}, [
      el('h2', { class: 'text-lg font-bold tracking-tight', text: station.name }),
      el('p', { class: 'text-sm text-base-content/60', text: participants.join(', ') || '—' }),
    ]),
    el('dl', { class: 'grid gap-x-6 gap-y-1 text-sm' }, [
      ...field('Region', station.region),
      ...field('Fuel', [...new Set(station.units.map((u) => u.fuel_type || 'Unspecified'))].join(', ')),
      ...field('Technology', techs.join(', ') || '—'),
      ...field('Registered capacity', `${fmtMW1.format(station.capacity)} MW`),
      ...field('Dispatch units', String(station.units.length)),
    ]),
    el('div', { class: 'flex flex-wrap items-center gap-3 text-sm' }, [
      wikipedia ? el('a', { class: 'link', href: wikipedia, rel: 'noopener', target: '_blank', text: 'Wikipedia' }) : null,
      website ? el('a', { class: 'link', href: website, rel: 'noopener', target: '_blank', text: 'Operator site' }) : null,
    ]),
    el('div', { id: 'live' }, [
      el('p', { class: 'text-sm text-base-content/60', text: 'Loading live output…' }),
    ]),
  );

  loadOutput(station, token).catch((err) => {
    if (token !== state.detailToken) return;
    console.error('station output load failed:', err);
    const live = $('live');
    live.textContent = '';
    live.append(el('p', {
      class: 'text-sm text-base-content/60',
      text: `Live output unavailable: ${err instanceof Error ? err.message : String(err)}`,
    }));
  });
}

function field(label, value) {
  return [
    el('dt', { class: 'text-[0.65rem] uppercase tracking-widest text-base-content/50', text: label }),
    el('dd', { text: value }),
  ];
}

async function loadOutput(station, token) {
  const duids = station.units.map((u) => u.duid);
  const payload = await fetchJson(`/api/v2/values?duid=${encodeURIComponent(duids.join(','))}&hours=24`);
  if (token !== state.detailToken) return;

  const output = facilityOutput(payload, duids);
  // `latest` is the last bucket in a 24-hour window that held any reading — for
  // a station that shut down this morning that is hours old, and calling it
  // "output now" in 36 px type would be a lie with a timestamp underneath it.
  // Two dispatch intervals of slack absorbs ordinary ingest lag.
  const stale = output.latest != null && Date.now() / 1000 - output.latest.time > 2 * DISPATCH_INTERVAL;
  const emissions = emissionsRate(station.units, output.latest?.byDuid);

  const live = $('live');
  live.textContent = '';
  live.append(
    el('p', {
      class: 'text-[0.65rem] uppercase tracking-widest text-base-content/50',
      text: stale ? 'Last reading, net' : 'Output now, net',
    }),
    el('p', {
      class: 'text-4xl font-semibold',
      text: output.latest ? `${fmtMW1.format(output.latest.value)} MW` : '—',
    }),
    el('p', {
      class: 'text-xs text-base-content/60',
      text: output.latest
        ? `${fmtWhen.format(output.latest.time * 1000)} AEST · 5-min interval ending${stale ? ' · not currently dispatching' : ''}`
        : 'No dispatch data in the last 24 hours.',
    }),
  );

  // Honest aggregation: a total summed over 4 of 5 units is labelled as such.
  if (output.latest?.absent.length) {
    live.append(el('p', {
      class: 'text-xs text-base-content/60',
      text: `Partial total — no reading this interval for ${output.latest.absent.join(', ')}.`,
    }));
  }
  if (output.missing.length) {
    live.append(el('p', {
      class: 'text-xs text-base-content/60',
      text: `Not reporting at all in this window: ${output.missing.join(', ')} — excluded from the total, not counted as zero.`,
    }));
  }

  live.append(sparkline(output), emissionsBlock(station, output, emissions, stale), unitTable(station, output));
}

const SPARK_W = 100;
const SPARK_H = 30;
// Vertical headroom in the viewBox: the highest and lowest readings map to
// y=0 and y=H exactly, so without it a steady output draws a flat line hard
// against the top edge and reads as a border rule rather than as data.
// Applied to the box, not the maths, so the geometry stays testable.
const SPARK_PAD = 4;

/* Sparkline over the 24 h facility total. The geometry (time axis, pen-up on
 * gaps, zero in the domain) is sparkPath() in stations.js and unit-tested
 * there; this is the SVG around it. */
function sparkline(output) {
  const wrap = el('div', {}, [
    el('p', { class: 'text-[0.65rem] uppercase tracking-widest text-base-content/50', text: 'Last 24 hours, MW' }),
  ]);
  const spark = sparkPath(output.timestamps, output.total, SPARK_W, SPARK_H);
  if (!spark) return wrap;

  const chart = document.createElementNS(SVG_NS, 'svg');
  chart.setAttribute('class', 'spark');
  chart.setAttribute('viewBox', `0 ${-SPARK_PAD} ${SPARK_W} ${SPARK_H + SPARK_PAD * 2}`);
  chart.setAttribute('preserveAspectRatio', 'none');
  chart.setAttribute('aria-hidden', 'true');
  // Only worth drawing when something went below it — a battery charging must
  // read as under the line, not merely as small.
  if (spark.low < 0) {
    const zero = document.createElementNS(SVG_NS, 'line');
    zero.setAttribute('class', 'spark-zero');
    zero.setAttribute('x1', '0');
    zero.setAttribute('x2', String(SPARK_W));
    zero.setAttribute('y1', spark.zeroY.toFixed(2));
    zero.setAttribute('y2', spark.zeroY.toFixed(2));
    chart.append(zero);
  }
  const line = document.createElementNS(SVG_NS, 'path');
  line.setAttribute('class', 'spark-line');
  line.setAttribute('d', spark.d);
  chart.append(line);

  wrap.append(chart, el('p', {
    class: 'text-xs text-base-content/60',
    text: `${fmtMW1.format(spark.low)} to ${fmtMW1.format(spark.high)} MW over the window`,
  }));
  return wrap;
}

function emissionsBlock(station, output, emissions, stale) {
  const factored = station.units.filter((u) => u.emissions_factor != null);
  const sources = [...new Set(station.units.map((u) => u.fuel_description || u.fuel_type).filter(Boolean))];
  const wrap = el('div', {}, [
    el('p', { class: 'text-[0.65rem] uppercase tracking-widest text-base-content/50', text: 'Emissions profile' }),
  ]);

  if (factored.length === 0) {
    wrap.append(el('p', {
      class: 'text-sm',
      text: 'AEMO publishes no CO₂ emission factor for this station’s units.',
    }), el('p', {
      class: 'text-xs text-base-content/60',
      text: 'No factor is not the same as no emissions — the estimate is withheld rather than reported as zero.',
    }));
    return wrap;
  }

  const range = [...new Set(factored.map((u) => u.emissions_factor))].sort((a, b) => a - b);
  wrap.append(el('p', {
    class: 'text-sm',
    text: `Factor ${range.length > 1
      ? `${fmtFactor.format(range[0])}–${fmtFactor.format(range[range.length - 1])}`
      : fmtFactor.format(range[0])} tCO₂-e/MWh sent out · ${sources.join(', ') || 'source unstated'}`,
  }));

  if (emissions.rate != null && !stale) {
    wrap.append(el('p', {
      // Two significant figures, never a fixed 0 dp: a small landfill-gas unit
      // emits well under 1 t/h, and rounding it to "≈ 0" is exactly the
      // reported-as-zero claim the note below this disclaims making.
      class: 'text-4xl font-semibold',
      text: `≈ ${fmtRate.format(emissions.rate)} tCO₂-e/h`,
    }), el('p', {
      class: 'text-xs text-base-content/60',
      text: `Estimated at the output above (${fmtMW1.format(emissions.coveredMw)} MW carrying a published factor).`,
    }));
  } else {
    wrap.append(el('p', {
      class: 'text-sm text-base-content/60',
      text: stale
        ? 'Not dispatching — a rate from the last reading would not be a current one.'
        : output.latest ? 'Not sending out — no emissions rate to estimate.' : 'No current output to estimate from.',
    }));
  }

  if (emissions.unfactored.length) {
    wrap.append(el('p', {
      class: 'text-xs text-base-content/60',
      text: `Excluded, no published factor: ${emissions.unfactored.join(', ')}.`,
    }));
  }
  wrap.append(el('p', {
    class: 'text-xs text-base-content/60',
    text: 'An estimate: AEMO’s factors are per MWh sent out while dispatch SCADA is as-generated, so this reads a few percent high. Charging and station load count as zero, never as negative emissions.',
  }));
  return wrap;
}

/** Per-DUID breakdown — the receipt for the facility total above it. */
function unitTable(station, output) {
  const head = el('tr', {}, ['Unit', 'Fuel', 'Cap MW', 'Now MW', 'tCO₂-e/MWh'].map((h) => el('th', { text: h })));
  const rows = station.units.map((unit) => {
    const value = output.latest?.byDuid?.[unit.duid];
    const reporting = output.reporting.includes(unit.duid);
    return el('tr', { class: reporting && value != null ? null : 'absent' }, [
      el('td', { text: unit.duid }),
      el('td', { text: unit.fuel_type || 'Unspecified' }),
      el('td', { text: unit.reg_cap == null ? '—' : fmtMW1.format(unit.reg_cap) }),
      el('td', {
        text: value != null ? fmtMW1.format(value) : (reporting ? 'no reading' : 'not reporting'),
      }),
      el('td', { text: unit.emissions_factor == null ? '—' : fmtFactor.format(unit.emissions_factor) }),
    ]);
  });
  return el('div', {}, [
    el('table', { class: 'unit-table' }, [el('thead', {}, [head]), el('tbody', {}, rows)]),
  ]);
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  const [basemap, snapshot, generators] = await Promise.all([
    fetchJson('/basemap.json'),
    fetchJson('/facilities.json'),
    fetchJson('/api/v2/generators'),
  ]);

  const { stations, unmatched, regionMismatch } = joinStations(snapshot, generators);
  state.stations = stations;
  state.byCode = new Map(stations.map((s) => [s.code, s]));

  renderBasemap(basemap);
  renderMarkers();
  setView(state.home);
  installPanZoom();
  // Marker fills and legend swatches are attribute-baked, so a theme switch
  // has to repaint them — the map's equivalent of the chart's canvas redraw.
  installTheme(() => {
    paintMarkers();
    renderLegend();
  });
  renderRegionFilter();
  renderLegend();
  renderStationSelect();

  const pinned = stations.reduce((n, s) => n + s.units.length, 0);
  // Both kinds of miss count against the denominator. Leaving the
  // region-disagreement units out of it entirely would make the coverage
  // figure IMPROVE every time the guard vetoed a station — the one number on
  // this page whose whole job is to admit what is missing.
  const joinable = pinned + unmatched.length + regionMismatch.length;
  $('station-count').textContent = fmtMW.format(stations.length);
  $('coverage-note').textContent =
    `${fmtMW.format(pinned)} of ${fmtMW.format(joinable)} registered dispatch units placed` +
    (unmatched.length ? ` · ${unmatched.length} without a known location` : '') +
    (regionMismatch.length ? ` · ${regionMismatch.length} whose location and region disagree` : '');
  if (regionMismatch.length) {
    console.warn('station map: units not pinned, snapshot and AEMO disagree on region:', regionMismatch);
  }

  // Deep links: /map.html?region=SA1&station=TORRB
  const params = new URLSearchParams(location.search);
  const region = params.get('region');
  if (region && REGIONS.some(([id]) => id === region)) setRegion(region);
  const station = params.get('station');
  if (station && state.byCode.has(station)) select(station);

  // A resize changes two things: the px->user factor the markers are drawn
  // with, and the box aspect the viewBox has to match.
  addEventListener('resize', reframe);
}

$('error-retry').addEventListener('click', () => location.reload());

boot().catch((err) => {
  console.error('station map load failed:', err);
  showError(`Failed to load the station map: ${err instanceof Error ? err.message : String(err)}`);
});
