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
export function alignOverlays(chartTimestamps, dispatch, region) {
  const price = new Array(chartTimestamps.length).fill(null);
  const demand = new Array(chartTimestamps.length).fill(null);
  if (!dispatch || !Array.isArray(dispatch.timestamps) || dispatch.timestamps.length === 0) {
    return { price, demand };
  }

  const index = new Map(dispatch.timestamps.map((t, i) => [t, i]));
  const selected = region ? dispatch.series.filter((s) => s.region === region) : dispatch.series;
  const single = region ? (selected[0] ?? null) : null;

  chartTimestamps.forEach((t, out) => {
    const i = index.get(t);
    if (i === undefined) return;
    if (single) price[out] = single.price[i] ?? null;
    let sum = 0;
    let saw = false;
    for (const s of selected) {
      const v = s.demand[i];
      if (v != null) {
        sum += v;
        saw = true;
      }
    }
    if (saw) demand[out] = sum;
  });

  return { price, demand };
}
