/* Pure price/demand overlay logic for the LAB-1700 dashboard — no DOM, no
 * uPlot, so test/overlays.spec.ts can exercise it directly (same split as
 * stacking.js).
 *
 * Overlay inks are deliberately NOT fuel-palette hues. Price is a magenta
 * absent from the fuel set, validated with the dataviz six-checks against its
 * nearest palette neighbours (fuel-oil red, fossil brown, battery violet) on
 * both surfaces — light #b83280 and dark #e264ae pass CVD separation and the
 * normal-vision floor. Demand is the neutral theme ink, rendered DASHED: over
 * a many-hued stack an achromatic dashed line is the most distinct mark
 * available, and its identity is carried by the dash pattern plus the
 * always-visible readout, not by hue (the categorical chroma floor does not
 * apply to it — it is a line ink, not a fill).
 */

export const OVERLAY_INKS = {
  price: { light: '#b83280', dark: '#e264ae' },
  demand: { light: '#1d232a', dark: '#e5e9f0' },
};

/* Align a /api/v2/dispatch payload onto the fuel-mix chart's time axis.
 *
 * `region` follows the dashboard's region filter: a NEM region id selects
 * that region's series; '' (NEM-wide) SUMS demand across all regions and
 * yields no price — the NEM has no single spot price, so the price array is
 * all-null and the caller hides the price line/axis.
 *
 * Buckets are computed by the same server-side expression on both endpoints,
 * so equal windows yield equal timestamps; any bucket one payload has and the
 * other lacks (ingest lag skew) stays null rather than misaligning. */
/* Project a /api/v2/rooftop payload (LAB-1701) onto the fuel-mix chart's
 * time axis as one values array for the rooftop band.
 *
 * The source is 30-minute; the chart axis can be 5-minute. Each estimate is a
 * mean MW over the half-hour ENDING at its timestamp, so every chart bucket
 * inside that half-hour carries the estimate (piecewise-constant — the
 * standard rendering of a period mean, not interpolation). A chart bucket
 * whose covering half-hour has NO published estimate stays null — never zero
 * — which is what renders the live edge (AEMO publishes ~30 min behind
 * SCADA) and any interior gap as honestly absent. At chart resolutions
 * ≥ 30 min both endpoints bucket identically and the covering lookup
 * degenerates to an exact timestamp join.
 *
 * `region` follows the dashboard filter: '' (NEM-wide) sums the regions that
 * have an estimate at that timestamp (same convention as demand above);
 * null only when none do. */
export function alignRooftop(chartTimestamps, chartResolution, rooftop, region) {
  const values = new Array(chartTimestamps.length).fill(null);
  if (
    !rooftop ||
    !Array.isArray(rooftop.timestamps) ||
    rooftop.timestamps.length === 0 ||
    !Array.isArray(rooftop.series)
  ) {
    return values;
  }

  const index = new Map(rooftop.timestamps.map((t, i) => [t, i]));
  const selected = region ? rooftop.series.filter((s) => s.region === region) : rooftop.series;
  // Buckets are period-ending and NEM-aligned (AEST +10). The covering step
  // is the coarser of the chart's resolution and the native 30 minutes: the
  // rooftop payload echoes the requested resolution even when its rows only
  // exist on half-hour boundaries.
  const step = Math.max(chartResolution, 1800);
  const NEM_OFFSET = 36000;

  chartTimestamps.forEach((t, out) => {
    const i = index.get(Math.ceil((t + NEM_OFFSET) / step) * step - NEM_OFFSET);
    if (i === undefined) return;
    let sum = 0;
    let saw = false;
    for (const s of selected) {
      const v = s.power?.[i];
      if (v != null) {
        sum += v;
        saw = true;
      }
    }
    if (saw) values[out] = sum;
  });

  return values;
}

export function alignOverlays(chartTimestamps, dispatch, region) {
  const price = new Array(chartTimestamps.length).fill(null);
  const demand = new Array(chartTimestamps.length).fill(null);
  if (
    !dispatch ||
    !Array.isArray(dispatch.timestamps) ||
    dispatch.timestamps.length === 0 ||
    !Array.isArray(dispatch.series)
  ) {
    return { price, demand };
  }

  const index = new Map(dispatch.timestamps.map((t, i) => [t, i]));
  const selected = region ? dispatch.series.filter((s) => s.region === region) : dispatch.series;
  const single = region ? (selected[0] ?? null) : null;

  chartTimestamps.forEach((t, out) => {
    const i = index.get(t);
    if (i === undefined) return;
    if (single) price[out] = single.price?.[i] ?? null;
    let sum = 0;
    let saw = false;
    for (const s of selected) {
      const v = s.demand?.[i];
      if (v != null) {
        sum += v;
        saw = true;
      }
    }
    if (saw) demand[out] = sum;
  });

  return { price, demand };
}
