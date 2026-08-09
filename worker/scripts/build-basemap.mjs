#!/usr/bin/env node
// Basemap generator for the station map (LAB-1702): turns Natural Earth's
// admin-1 boundaries into public/basemap.json — the five NEM regions plus the
// two non-NEM mainland jurisdictions, as lon/lat rings.
//
// WHY a vendored vector basemap instead of a tile service: the map must work
// in both themes and must not depend on a third-party tile endpoint at
// runtime. Raster tiles fail both — an OSM basemap has to be CSS-inverted to
// survive dark mode, and every page view hits someone else's server under
// their usage policy. A 30 kB ring file themes with a CSS variable, ships from
// our own origin like the rest of public/, and makes the NEM regions the
// basemap's own subject rather than something drawn on top of one.
//
// Natural Earth is public domain (no attribution required; we credit it
// anyway). Pinned to a release tag so a re-run is reproducible.
//
// Run: node scripts/build-basemap.mjs   (borders do not move — this is a
// one-shot generator, re-run only to change scale or jurisdictions.)
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const NE_TAG = 'v5.1.2';
const SOURCE_URL =
  `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NE_TAG}/geojson/ne_50m_admin_1_states_provinces.geojson`;

const OUT_PATH = new URL('../public/basemap.json', import.meta.url);

// Natural Earth `postal` -> NEM region id. The NEM's NSW1 region covers the
// ACT and Jervis Bay too, but both are enclaves inside the NSW polygon, so
// their rings would only draw a border artefact inside NSW — the geography is
// already there. WA and NT are separate grids (API.md), drawn muted so the
// five NEM regions read as the subject rather than the whole continent.
const REGIONS = [
  { id: 'QLD1', label: 'QLD', postal: 'QL' },
  { id: 'NSW1', label: 'NSW', postal: 'NS' },
  { id: 'VIC1', label: 'VIC', postal: 'VI' },
  { id: 'SA1', label: 'SA', postal: 'SA' },
  { id: 'TAS1', label: 'TAS', postal: 'TS' },
  { id: '', label: 'WA', postal: 'WA' }, // '' id = not a NEM region
  { id: '', label: 'NT', postal: 'NT' },
];

// 3 dp ~= 110 m at this latitude. The map's widest zoom spans ~4000 km across
// ~900 px, so a pixel is ~4 km: three decimals is already three orders of
// magnitude finer than anything that can be seen.
const DP = 1000;
const round = (n) => Math.round(n * DP) / DP;

/**
 * GeoJSON Polygon/MultiPolygon -> flat [lng,lat,lng,lat,…] rings, rounded.
 *
 * Only EXTERIOR rings (`polygon[0]`) are kept; interior rings are dropped.
 * At this scale the only interior ring in the set is the ACT punched out of
 * New South Wales — and the NEM's NSW1 region includes the ACT, so keeping it
 * would render a hole in a region that electrically has none. Separate
 * polygons (Kangaroo Island, Bruny Island, the Bass Strait islands) are
 * exterior rings of their own and survive.
 *
 * Rings that collapse below a triangle once rounded are dropped — at 3 dp
 * that is a feature smaller than a pixel, not a landmass.
 */
function ringsOf(geometry) {
  const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  const rings = [];
  for (const [exterior] of polygons) {
    const flat = [];
    let prev = '';
    for (const [lng, lat] of exterior) {
      const key = `${round(lng)},${round(lat)}`;
      if (key === prev) continue; // rounding collapsed consecutive vertices
      prev = key;
      flat.push(round(lng), round(lat));
    }
    if (flat.length >= 6) rings.push(flat);
  }
  return rings;
}

// cache: 'no-store' is a no-op in Node's undici (no HTTP cache) — it
// declares freshness intent for runtimes that do cache.
const res = await fetch(SOURCE_URL, { cache: 'no-store', signal: AbortSignal.timeout(60_000) }).catch((err) => {
  throw new Error(`fetching ${SOURCE_URL}: ${err.message} — basemap.json left untouched`, { cause: err });
});
assert.ok(res.ok, `HTTP ${res.status} fetching Natural Earth admin-1 — basemap.json left untouched`);
const { features } = await res.json().catch((err) => {
  throw new Error(`parsing Natural Earth admin-1 JSON: ${err.message}`, { cause: err });
});

const out = REGIONS.map(({ id, label, postal }) => {
  const feature = features.find((f) => f.properties.adm0_a3 === 'AUS' && f.properties.postal === postal);
  assert.ok(feature, `Natural Earth has no AUS feature with postal="${postal}" — schema drift?`);
  const rings = ringsOf(feature.geometry);
  assert.ok(rings.length > 0, `${label} produced no rings`);
  return { id, label, rings };
});

writeFileSync(
  OUT_PATH,
  `${JSON.stringify(
    {
      _generated_by: 'scripts/build-basemap.mjs — do not hand-edit',
      source: SOURCE_URL,
      license: 'Natural Earth — public domain (https://www.naturalearthdata.com/about/terms-of-use/)',
      note: 'rings are flat [lng,lat,lng,lat,…]; id "" = jurisdiction outside the NEM',
      regions: out,
    },
    null,
    0,
  )}\n`,
);

const vertices = out.reduce((n, r) => n + r.rings.reduce((m, ring) => m + ring.length / 2, 0), 0);
console.log(`Wrote public/basemap.json — ${out.length} jurisdictions, ${vertices} vertices`);
