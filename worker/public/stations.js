/* Pure station-map logic for LAB-1702 — no DOM, no fetch, so
 * test/stations.spec.ts can exercise it directly (same split as stacking.js /
 * overlays.js). Shared by the browser (map.js) and the build script
 * (scripts/build-facilities.mjs), so the DUID join has exactly one
 * implementation and one test suite.
 *
 * Two joins live here and they are NOT the same join:
 *
 *   buildSnapshot()  Open Electricity facility dump -> public/facilities.json.
 *                    Build-time, run by hand when the snapshot is refreshed.
 *   joinStations()   facilities.json x /api/v2/generators -> map markers.
 *                    Runtime, every page load. The registration table
 *                    refreshes weekly and the snapshot does not, so this join
 *                    stays late and honest instead of being frozen at build
 *                    time.
 */

/* --------------------------------------------------------------------------
 * Build-time: Open Electricity dump -> compact snapshot
 */

/**
 * AEMO DUIDs an Open Electricity unit code can stand for.
 *
 * OE's `units[].code` is the AEMO DUID for ordinary generators, but batteries
 * are modelled as a synthesised charge/discharge pair with a `0` prefix and an
 * L/G/B infix — AEMO's bidirectional `BRDDBES1` appears as `0BRDDBESL1` and
 * `0BRDDBESG1`. Without this rule every grid battery in the NEM (67 of 477
 * dispatching units when measured on 2026-08-09) falls off the map, which is
 * most of the story on a modern NEM day.
 *
 * The rule is deterministic and its output is checked, not trusted:
 * buildSnapshot refuses to let an alias claim a DUID another facility owns
 * exactly, or that two facilities' aliases both claim, and the runtime join
 * additionally drops any unit whose facility disagrees with AEMO about which
 * NEM region it sits in. Measured on the 2026-08-09 dump: zero conflicts,
 * zero region disagreements.
 */
export function unitAliases(code) {
  const candidates = [code];
  if (code.startsWith('0')) {
    candidates.push(code.slice(1));
    const split = /^0(.+)[LGB](\d)$/.exec(code);
    if (split) candidates.push(split[1] + split[2]);
  }
  return [...new Set(candidates)];
}

/**
 * Open Electricity `data[]` -> `{ facilities, skipped, conflicts }`.
 *
 * Deliberately narrow: coordinates, identity and the two link fields, nothing
 * else. OE's own `capacity_registered` and `emissions_factor_co2` are dropped
 * — capacity comes from AEMO's registration list (our `generators` table) and
 * the emission factor from AEMO's CDEII report, both of which we already hold
 * under an attribution-only licence. The snapshot therefore carries the
 * minimum of OE's CC BY-NC data needed to put a pin on a map.
 *
 * `conflicts` is returned rather than thrown so the caller decides: the build
 * script aborts on it.
 */
export function buildSnapshot(data) {
  const facilities = [];
  const skipped = [];
  const conflicts = [];
  const owner = new Map(); // duid -> { index, kind }

  const sources = []; // parallel to `facilities`, holds the upstream units[]
  for (const facility of data) {
    if (facility.network_id !== 'NEM') continue;
    const { lat, lng } = facility.location ?? {};
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      skipped.push({ code: facility.code, reason: 'no coordinates' });
      continue;
    }
    facilities.push({
      code: facility.code,
      name: facility.name,
      region: facility.network_region,
      lat,
      lng,
      // Facility-level wikipedia; website is the operating owner's, which is
      // the only website OE carries. Both optional upstream.
      wikipedia: facility.wikipedia ?? null,
      website: facility.owners?.find((o) => o.website)?.website ?? null,
      duids: {},
    });
    sources.push((facility.units ?? []).map((u) => u.code).filter(Boolean));
  }

  const claim = (index, duid, kind) => {
    const held = owner.get(duid);
    if (held) {
      // First claim wins even within one facility: the exact pass runs before
      // the alias pass, so an alias must never downgrade an exact `kind`.
      if (held.index !== index) {
        conflicts.push({
          duid,
          kind,
          facility: facilities[index].code,
          heldBy: facilities[held.index].code,
          heldKind: held.kind,
        });
      }
      return;
    }
    owner.set(duid, { index, kind });
    facilities[index].duids[duid] = kind;
  };

  // Exact codes first, across ALL facilities, so an alias can never take a
  // DUID an exact code owns whatever order the dump happens to be in.
  sources.forEach((codes, index) => codes.forEach((code) => claim(index, code, 'exact')));
  sources.forEach((codes, index) =>
    codes.forEach((code) => unitAliases(code).slice(1).forEach((alias) => claim(index, alias, 'alias'))),
  );

  return { facilities, skipped, conflicts };
}

/* --------------------------------------------------------------------------
 * Runtime: snapshot x generators -> stations
 */

/**
 * `{ stations, unmatched, regionMismatch }` from a facilities snapshot and an
 * `/api/v2/generators` payload.
 *
 * Nothing is silently dropped. A DUID the snapshot has never heard of lands in
 * `unmatched`; a DUID whose facility disagrees with AEMO about the NEM region
 * lands in `regionMismatch` and is NOT pinned — a marker in the wrong state is
 * worse than a missing one, and the disagreement means one of the two sources
 * is wrong about which unit this is.
 *
 * A CONTRADICTION is the trigger, not an absence: AEMO's registration workbook
 * ships the odd row with a blank Region (ADPPV3, a 20 kW rooftop array at the
 * Adelaide desalination plant, on the 2026-08-09 list). Blank is not a second
 * opinion, so the snapshot's region stands and the unit is pinned — vetoing a
 * real station over a hole in our own reference data would be the guard
 * working against its own purpose.
 *
 * Non-market units (`duid` = '-', per the schema) are neither pinned nor
 * counted as unmatched: they have no dispatch data to show and no DUID to join
 * on, so they are not part of this map's universe.
 */
export function joinStations(snapshot, generators) {
  const owner = new Map();
  for (const facility of snapshot.facilities) {
    for (const [duid, kind] of Object.entries(facility.duids)) owner.set(duid, { facility, kind });
  }

  const stations = new Map();
  const unmatched = [];
  const regionMismatch = [];

  for (const generator of generators) {
    const duid = generator.duid;
    if (!duid || duid === '-') continue;
    const hit = owner.get(duid);
    if (!hit) {
      unmatched.push({ duid, name: generator.name, state: generator.state, fuel_type: generator.fuel_type });
      continue;
    }
    if (generator.state && hit.facility.region !== generator.state) {
      regionMismatch.push({ duid, ours: generator.state, snapshot: hit.facility.region, facility: hit.facility.code });
      continue;
    }
    let station = stations.get(hit.facility.code);
    if (!station) {
      const { code, name, region, lat, lng, wikipedia, website } = hit.facility;
      station = { code, name, region, lat, lng, wikipedia, website, units: [], capacity: 0, fuel: '' };
      stations.set(code, station);
    }
    station.units.push({ ...generator, match: hit.kind });
    station.capacity += generator.reg_cap ?? 0;
  }

  for (const station of stations.values()) {
    station.units.sort((a, b) => a.duid.localeCompare(b.duid));
    station.fuel = dominantFuel(station.units);
  }

  return { stations: [...stations.values()], unmatched, regionMismatch };
}

/**
 * The fuel a station is coloured by: the one carrying the most registered
 * capacity. A hybrid site (solar + battery) is a real thing and one marker
 * cannot say both — the drill-down lists every unit's own fuel, so the marker
 * only has to answer "what is this place, mostly". Ties break on unit count
 * then alphabetically so the colour never depends on payload order.
 */
export function dominantFuel(units) {
  const byFuel = new Map();
  for (const unit of units) {
    const key = unit.fuel_type ?? '';
    const entry = byFuel.get(key) ?? { capacity: 0, count: 0 };
    entry.capacity += unit.reg_cap ?? 0;
    entry.count += 1;
    byFuel.set(key, entry);
  }
  // '' for no units: the empty key is already this function's "unspecified
  // fuel" answer, and an exported pure function should not throw on [].
  return [...byFuel.entries()].sort(
    (a, b) => b[1].capacity - a[1].capacity || b[1].count - a[1].count || a[0].localeCompare(b[0]),
  )[0]?.[0] ?? '';
}

/* --------------------------------------------------------------------------
 * Projection
 */

/**
 * Web Mercator, in the same degree-ish units the input longitude uses, so a
 * viewBox can be expressed in readable lon/lat-like numbers. SVG's y grows
 * downward, hence the negation: north is up.
 *
 * Equirectangular would be one line shorter and would stretch Australia by
 * ~10% east-west at these latitudes — enough that the continent stops looking
 * like itself, which is the one thing a basemap has to get right.
 */
export function mercator(lng, lat) {
  const clamped = Math.max(-85, Math.min(85, lat));
  return { x: lng, y: -(180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) };
}

/**
 * Marker radius for a station's registered capacity, scaled by AREA (√) —
 * a 2000 MW station must not read as 100x a 20 MW one because its radius grew
 * 100x. `min` is a floor, not a scale point: below it a marker stops being
 * clickable, and an unclickable pin is the same as no pin.
 */
export function markerRadius(capacity, maxCapacity, min = 3, max = 16) {
  if (!(maxCapacity > 0)) return min;
  const share = Math.sqrt(Math.max(0, capacity) / maxCapacity);
  return min + (max - min) * Math.min(1, share);
}

/* --------------------------------------------------------------------------
 * Drill-down: facility-level output from per-DUID series
 */

/**
 * Sum an `/api/v2/values` payload to facility level, keeping the absences
 * visible.
 *
 * - `reporting` / `missing` split the requested DUIDs by whether the window
 *   holds any sample at all for them. A unit that reported nothing in 24 h is
 *   not a zero — it is a unit we have no data for, and the drill-down says so
 *   rather than quietly summing 4 units and calling it a 5-unit station.
 * - `total[i]` sums only the units with a sample in that bucket, and is null
 *   when none have one. `absent` on the latest bucket names the reporting
 *   units that happened to be missing right there, so a partial live total is
 *   labelled partial instead of read as a drop in output.
 */
export function facilityOutput(payload, duids) {
  const timestamps = payload?.timestamps ?? [];
  const byDuid = new Map((payload?.series ?? []).map((s) => [s.duid, s.values ?? []]));

  const reporting = duids.filter((d) => byDuid.get(d)?.some((v) => v != null));
  const reportingSet = new Set(reporting);
  const missing = duids.filter((d) => !reportingSet.has(d));

  const total = timestamps.map((_, i) => {
    let sum = 0;
    let saw = false;
    for (const duid of reporting) {
      const v = byDuid.get(duid)[i];
      if (v != null) {
        sum += v;
        saw = true;
      }
    }
    return saw ? sum : null;
  });

  let latest = null;
  for (let i = total.length - 1; i >= 0; i -= 1) {
    if (total[i] == null) continue;
    const byDuidLatest = {};
    const absent = [];
    for (const duid of reporting) {
      const v = byDuid.get(duid)[i];
      if (v == null) absent.push(duid);
      else byDuidLatest[duid] = v;
    }
    latest = { value: total[i], time: timestamps[i], byDuid: byDuidLatest, absent };
    break;
  }

  return { timestamps, total, latest, reporting, missing };
}

/**
 * Sparkline geometry for a facility total: `{ d, low, high, zeroY }` in a
 * `W × H` box, or null when there is nothing to draw.
 *
 * Three rules, all about not drawing data that does not exist:
 * - x is TIME, not bucket index. `/api/v2/values` returns only buckets that
 *   hold a sample, so an index axis would render a two-hour outage at the same
 *   slope as two adjacent five-minute intervals and the gap would vanish.
 * - a null bucket lifts the pen. The path breaks and resumes; it never bridges
 *   across missing data. A reading isolated between two nulls still emits a
 *   zero-length segment, so one sample after an outage is a round dot rather
 *   than nothing at all.
 * - `low`/`high` are the REAL extremes of the data, not the plot domain. The
 *   domain is padded to include zero so a charging battery reads as below the
 *   baseline rather than merely small — but a caller captioning the domain
 *   would tell every always-on coal station it fell to 0 MW overnight.
 */
export function sparkPath(timestamps, total, width, height) {
  const present = total.filter((v) => v != null);
  // The length guard is not decoration: the two arrays come from one payload
  // today, but a mismatched pair silently produces NaN coordinates rather than
  // a visible failure, and this function is exported.
  if (present.length < 2 || timestamps.length !== total.length) return null;

  const low = Math.min(...present);
  const high = Math.max(...present);
  const min = Math.min(0, low);
  const max = Math.max(0, high);
  const span = max - min || 1;
  const t0 = timestamps[0];
  const tSpan = timestamps[timestamps.length - 1] - t0 || 1;
  const px = (i) => ((timestamps[i] - t0) / tSpan) * width;
  const py = (v) => height - ((v - min) / span) * height;

  let d = '';
  let open = false; // a segment is in progress
  let alone = true; // …and it is still a single point
  total.forEach((v, i) => {
    if (v == null) {
      if (open && alone) d += `L${px(i - 1).toFixed(2)} ${py(total[i - 1]).toFixed(2)}`;
      open = false;
      return;
    }
    if (open) {
      d += `L${px(i).toFixed(2)} ${py(v).toFixed(2)}`;
      alone = false;
    } else {
      d += `M${px(i).toFixed(2)} ${py(v).toFixed(2)}`;
      open = true;
      alone = true;
    }
  });
  const last = total.length - 1;
  if (open && alone) d += `L${px(last).toFixed(2)} ${py(total[last]).toFixed(2)}`;

  return { d, low, high, zeroY: py(0) };
}

/**
 * Estimated emissions rate at an instant: Σ(MW × factor) over the units
 * dispatching right now, in tCO₂-e/h.
 *
 * Follows /api/v2/intensity's conventions exactly (worker/API.md) so the two
 * numbers on this site never contradict each other:
 * - negative output is clamped to zero — a charging battery or a pump load is
 *   not sending anything out, so it is in neither half of the ratio;
 * - a unit with no published CDEII factor is EXCLUDED and disclosed, never
 *   treated as zero-emission, because "we have no factor for this unit" and
 *   "this unit emits nothing" are different statements;
 * - factors are per MWh SENT OUT while SCADA is as-generated, so the estimate
 *   reads a few percent high. The caller must label it as an estimate.
 */
export function emissionsRate(units, latestByDuid) {
  let rate = 0;
  let coveredMw = 0;
  const unfactored = [];

  for (const unit of units) {
    const mw = latestByDuid?.[unit.duid];
    if (mw == null || mw <= 0) continue;
    if (unit.emissions_factor == null) {
      unfactored.push(unit.duid);
      continue;
    }
    rate += mw * unit.emissions_factor;
    coveredMw += mw;
  }

  // `coveredMw` is the MW the rate was actually computed over and `unfactored`
  // names what was left out — between them the caller can state the shortfall
  // exactly, which is why there is no separate coverage ratio to round.
  return { rate: coveredMw > 0 ? rate : null, coveredMw, unfactored };
}
