# nem-api v2 — public data contract

Pinned contract for the query API (LAB-418), owned jointly with the LAB-419
frontend. **This is a public API** (decision: ray, 2026-07-24 — public until
abuse is detected; no auth/rate-limiting until then), so treat the shapes
below as a stable external contract, not an internal convenience. Breaking
changes require touching both this file and the frontend in the same PR.

All endpoints: `GET`, JSON, CORS `*`, gzip via Cloudflare. Times are **unix
seconds** unless a field says otherwise. Errors are `{ "error": "<message>" }`
with a 4xx/5xx status; malformed parameters are rejected with a 400, never
silently coerced.

## What the data is (read this before charting)

- Values are AEMO Dispatch **`UNIT_SCADA`** readings: instantaneous MW per
  dispatch unit (DUID) every 5 minutes.
- **The numbers are grid-scale generation — NOT demand and NOT total
  supply.** Rooftop solar is behind-the-meter and absent from Dispatch SCADA,
  so stack heights understate total supply by the (large, growing) rooftop
  amount. Do not label a stacked total as "demand".
- **Values are NET MW.** Storage charging and station load draw come through
  as negative values and are preserved: aggregates `SUM()` them net, so a
  fuel band can legitimately go negative (e.g. batteries charging). Stacked
  charts must handle negative bands.
- **Region** is the NEM region id — exactly five: `QLD1`, `NSW1`, `VIC1`,
  `SA1`, `TAS1`. WA and NT are separate grids and structurally absent.
  No region filter = NEM-wide, which is the sensible default.
- DUIDs missing from the `generators` reference are excluded **at ingest**
  (logged there; the registration refresh — LAB-421 — is the fix), so they
  never appear here. Mapped generators with a NULL fuel/tech value appear in
  aggregates under the key `""` rather than being dropped.

## Time semantics

- `scrape_time` values are AEMO **SETTLEMENTDATE**s: period-**ending**
  timestamps in NEM market time (AEST, UTC+10, **no DST**), stored as unix
  seconds.
- Bucket labels in `timestamps` are also **period-ending**: a bucket labelled
  `t` covers `(t - resolution, t]`. A sample ending exactly on a boundary
  belongs to the bucket ending there.
- Daily (`resolution=86400`) buckets end at **AEST midnight**, not UTC
  midnight. Sub-daily buckets are unaffected by the offset (10 h is a whole
  multiple of 5/30/60 min).

## Caching (LAB-768)

Responses are served through a caching layer — cachekit
(`@cachekit-io/cachekit/workers`, Cache API backend: per-colo,
point-of-presence). What a consumer sees:

- `x-cache: HIT | MISS` on every cacheable response, plus
  `cache-control: public, max-age=<seconds>` reflecting the **remaining**
  entry lifetime and `x-cache-expires` (unix seconds) for when it lapses.
- **Freshness**: any window that can still gain samples (touches the current
  dispatch interval, open-ended, or relative) is cached only to the current
  5-minute dispatch boundary — never past it — so worst-case staleness is
  one interval. Fully-past windows are immutable and cache for 24 h
  (bounded so late ARCHIVE backfills still surface). `generators` caches
  for 1 h (registration data refreshes out-of-band, roughly weekly).
- **Keys are canonical**: an alias and its canonical param, or ISO and unix
  forms of the same time, share one cache entry; unrecognised params are
  ignored. Relative windows (`hours=24`, the 24 h default) are cached
  per-interval — their echoed `start`/`end` may lag up to one interval.
- Errors are never cached.

## `GET /api/v2/values`

Per-generator MW, pivoted onto a shared time axis. This is the drill-down
endpoint; the headline fuel-mix view is `values/aggregate` below.

```jsonc
{
  "start": 1784901600,        // resolved window start (null if only `time`/`time_end` given)
  "end": 1784902200,          // resolved window end (null when open-ended "from now")
  "resolution": 300,          // bucket width in seconds actually used
  "truncated": false,         // true when the row limit cut the response short
  // shared x-axis, ascending, period-ENDING: these buckets cover
  // (1784901600, 1784901900] and (1784901900, 1784902200]
  "timestamps": [1784901900, 1784902200],
  "series": [
    {
      "id": 12,               // generators.id
      "duid": "BAPS",         // AEMO dispatch unit id
      "name": "Banimboola Power Station",
      "fuel": "Hydro",        // generators.fuel_type (series coloring)
      "values": [10, 12]      // MW, aligned to `timestamps`; null = no sample in bucket
    }
  ]
}
```

`values[i]` is the **mean MW over the bucket ending at `timestamps[i]`**
(rounded to 4 dp). uPlot consumption is
`[timestamps, ...series.map(s => s.values)]`.

If `truncated` is true, narrow the filters, coarsen `resolution`, or page
with `offset`.

Resolutions `3600`/`86400` are served from the same per-generator rollup
tables as `values/aggregate` (LAB-1696/LAB-1721), so long windows — up to the
full ~13-month retention — stay interactive instead of failing. `values[i]` at
these two resolutions is the exact mean of *that generator's own* reported
samples in the bucket (`sum_value / n_samples`) — no cross-generator interval
count to reconcile, so this is the raw path's `AVG(value)` exactly, not an
approximation of it. As with `values/aggregate`, a bucket straddling
`time_start`/`time_end` reports the full bucket's mean. Exact `time=` lookups
and resolutions `300`/`1800` read raw rows as before.

### Query parameters

**Time window:**

| Param | Meaning |
|---|---|
| `time` | exact dispatch interval (unix seconds or ISO string) |
| `time_start` | window start (unix seconds or ISO) |
| `time_end` | window end (unix seconds or ISO) |
| `minutes` / `hours` / `days` / `weeks` / `months` | relative window; first one present wins, in that order |

ISO strings **without an explicit offset are NEM time (AEST, `+10:00`)** —
the runtime timezone never leaks into parsing; a date-only string means AEST
midnight. Explicit `Z` / `±hh:mm` offsets are honoured as given.

Relative-window combinations: no start/end → from now, counting back
(open-ended end); with `time_start` → `[start, start+window]` (a given
`time_end` is ignored); with only `time_end` → `[end-window, end]`.
`months` is calendar arithmetic, clamped to month end. **No time params at
all → the last 24 hours.**

**Bucketing**: `resolution` — one of `300`, `1800`, `3600`, `86400` seconds.
Unset → auto by window span: ≤3 days → 300, ≤14 days → 1800, ≤90 days → 3600,
else 86400.

An **explicit** `resolution=300` or `resolution=1800` is rejected with a 400
("window too wide for resolution=…") if the window's span exceeds that
resolution's cap — 3 days for `300`, 14 days for `1800` (the same boundary the
auto-pick above already uses; `300`/`1800` never route to rollups, so a wider
window would GROUP BY raw rows and risk the SQLITE_NOMEM failure LAB-1696
exists to avoid). `3600`/`86400` have no such cap on `values`/`values/aggregate`
— both are served from rollups at any span. An exact `time=` lookup is always
one interval and is never capped. This applies to `values` and
`values/aggregate`; `/api/v2/intensity` has its own, stricter floor (see
below).

**Generator filters** (also on `generators` and `values/aggregate`). One
canonical name per field, plus at most one alias; when both are given the
canonical name wins:

| Field | Canonical | Alias |
|---|---|---|
| NEM region | `region` | `state` |
| Fuel type | `fuel` | `fuel_type` |
| Fuel description | `fuel_desc` | `fuel_description` |
| Technology type | `tech` | `technology_type` |
| Technology description | `tech_desc` | `technology_description` |
| Dispatch unit | `duid` | — |

Operator inference per value: contains `,` → `IN` over the split values;
contains `*` → `LIKE` with `*` as the wildcard (**`*` is the only wildcard**;
`%` and `_` are matched literally); otherwise `=`. All values are bound
parameters — never interpolated.

**Paging / order**: `limit` (integer 1–300000, default 300000), `offset`
(default 0), `sort`/`order` = `<field>[,asc|desc]` with field one of `time`,
`generator_id`, `value` (allowlisted; anything else is a 400).

`limit`/`offset`/`sort` operate on the grouped **(bucket, generator) rows
before pivoting** — they bound which data points the response covers, with
deterministic `bucket, generator` tie-breaks for stable paging. They do not
reorder the pivoted output: `timestamps` is always ascending regardless of
`sort`. The same pre-pivot paging applies to `values/aggregate` (whose row
order is fixed to time-ascending).

## `GET /api/v2/values/aggregate?group_by=fuel|tech|region`

**The headline endpoint**: net generation totals bucketed by fuel type,
technology type, or NEM region — feeds the fuel/tech-mix stacked-area view.
Same envelope, params, and alignment rules as `values`, plus `group_by`
(required; `state` is accepted as an alias of `region`). `sort` is not
supported here; order is always time-ascending.

```jsonc
{
  "group_by": "fuel",
  "start": 1784901600,
  "end": 1784902200,
  "resolution": 1800,
  "truncated": false,
  "timestamps": [1784903400],
  "series": [
    { "key": "Fossil", "values": [1300] },   // key = group value ("" when NULL)
    { "key": "Hydro",  "values": [15] }
  ]
}
```

`values[i]` is the mean over the bucket of the **per-interval summed net MW**
across the group's generators (mean-of-sums — stays correct when a unit
misses an interval inside the bucket). Negative intervals (storage charging,
station load) are summed net, per the convention above.

Resolutions `3600`/`86400` are served from pre-aggregated rollups (LAB-1696)
so long windows — up to the full ~13-month retention — stay interactive
instead of failing. Two visible consequences at these two resolutions only:
a group with **no samples at all** in some of a bucket's intervals is averaged
over the bucket's full interval count (a unit offline half a day reads as its
energy-correct daily mean, not its while-running mean), and a bucket
straddling `time_start`/`time_end` reports the full bucket's mean rather than
only the in-window portion. Exact `time=` lookups and resolutions
`300`/`1800` read raw rows as before.

## `GET /api/v2/dispatch`

Regional 5-minute **spot price and demand** from AEMO DispatchIS
(`DISPATCH,PRICE` RRP and `DISPATCH,REGIONSUM` TOTALDEMAND), bucketed onto
the same shared time axis as `values`. Feeds the dashboard's price/demand
overlays.

Same time-window, `resolution`, `limit`/`offset` grammar and period-ending
NEM-time bucket alignment as `values`. The only filter is `region` (alias
`state`), with the usual operator inference (`,` → IN, `*` → LIKE wildcard).
No `group_by` (region **is** the series) and no `sort` (order is always
time-ascending).

```jsonc
{
  "start": 1784901600,
  "end": 1784902200,
  "resolution": 300,
  "truncated": false,
  "timestamps": [1784901900, 1784902200],
  "series": [
    {
      "region": "NSW1",
      "price": [110.01, 99.73],      // mean RRP over the bucket, $/MWh
      "price_max": [110.01, 99.73],  // max RRP in the bucket, $/MWh
      "demand": [9655.98, 9660.12]   // mean TOTALDEMAND over the bucket, MW
    }
  ]
}
```

What the data is:

- `price` is the AEMO **regional reference price (RRP)** for the dispatch
  run, `INTERVENTION=0` rows only. **Negative prices are a routine NEM
  state** (midday solar oversupply), not an error — consumers must render
  them.
- `price_max` is the **maximum RRP inside the bucket**: at `resolution=300`
  it equals `price`; at coarser resolutions it preserves spikes (a
  $10,000/MWh interval must not vanish into an hourly mean).
- `demand` is the **dispatch-run `TOTALDEMAND`** — AEMO's demand series used
  by the dispatch solution, not the separately measured operational-demand
  series (the two differ slightly).
- Interconnector flows (`DISPATCH,INTERCONNECTORRES` METEREDMWFLOW) are
  ingested and stored but **deliberately not exposed** yet — a flow-map view
  is a later epic candidate; the shape here would be a new field, not a
  breaking change.
- `null` = no ingested sample in that bucket, same as `values`.

## `GET /api/v2/intensity`

**Grid carbon intensity per NEM region, and NEM-wide** — how much CO₂-e each
MWh of dispatched generation carries, estimated at dispatch cadence from
AEMO's own published emission factors. `tCO2-e/MWh` is numerically identical
to the `gCO2-e/kWh` most consumers expect: multiply by 1000.

```jsonc
{
  "start": 1784901600,
  "end": 1784988000,
  "resolution": 86400,
  "unit": "tCO2-e/MWh",
  "timestamps": [1784988000],
  "series": [
    // NEM first, then regions ascending.
    { "key": "NEM",  "values": [0.6314], "coverage": [0.994], "official": [0.6005] },
    { "key": "NSW1", "values": [0.6504], "coverage": [0.999], "official": [0.6329] }
  ]
}
```

- `values[i]` — the estimate for the bucket ending at `timestamps[i]`, 4 dp.
  `null` means no generation with a published factor in that bucket, which is
  never the same statement as `0`.
- `coverage[i]` — the fraction of that bucket's dispatched MW that carried a
  published factor (see *Coverage* below). `null` when there was no
  generation at all.
- `official[i]` — AEMO's own published daily index for the same region-day,
  **present exactly when the response is daily** — i.e. `resolution=86400`
  *and* whole-bucket (see below); an exact `time=` lookup is neither, whatever
  resolution it carries. When present it is always a full-length array (an
  empty window gives `[]`, never a missing field). `null` where AEMO has not
  published that day yet — the file republishes weekly, so the most recent
  days are normally null.

Accepts the same time-window parameters as `values`. It does **not** accept
`limit`, `offset`, `sort`, or the generator filters: intensity is defined per
region and always returns every region (≤6 series), the emissions of an
arbitrary fuel subset over the output of that same subset is a confidently
wrong number, and paging a ratio series is how you get a NEM figure summed
over half its regions. Those params are ignored, and — like any unrecognised
param — do not affect the cache key.

**Bucket edges.** At `resolution` `3600`/`86400` this endpoint is served from
the same pre-aggregated rollups as `values/aggregate` (LAB-1696), with the
same visible consequence: **a bucket straddling `time_start`/`time_end`
reports the whole bucket**, not just the in-window part. `300`/`1800` and
exact `time=` read raw rows and clip to the window.

**`resolution` has a floor here.** Unlike `values` and `values/aggregate`,
this endpoint rejects a resolution finer than the one it would auto-pick for
the window (`?months=13&resolution=300` → 400). The per-generator grouping
intensity needs cannot be served at 5-minute grain across a year, and
returning a 500 instead of saying so would be worse. Omit `resolution` and
you always get a servable one.

### How it is computed

Per bucket, per region:

```
intensity = Σ(MW × factor) / Σ(MW)     over generators with a published factor
```

energy-weighted — the same ratio-of-sums AEMO uses for its own index
(`TOTAL_EMISSIONS / TOTAL_SENT_OUT_ENERGY`), which is what makes the two
directly comparable. The NEM series is the ratio of the summed halves across
regions, **not** the mean of the regional intensities: a quiet Tasmania must
not weigh the same as a loaded New South Wales.

Factors come from AEMO's CDEII report
([`CO2EII_AVAILABLE_GENERATORS.CSV`](https://nemweb.com.au/Reports/Current/CDEII/),
one per DUID, derived by AEMO from ISP/NGA data), refreshed daily and joined
on DUID — no name matching. `MW` is the dispatch SCADA already behind
`/api/v2/values`. A DUID that AEMO ever lists with two *different* factors is
dropped rather than guessed at, and then shows up in `coverage` like any
other unfactored unit.

**Negative MW.** A generator's *net* output over a bucket is clamped at zero,
so a unit that is a net consumer in that bucket — a charging battery, a pump
load, station draw — contributes to neither the numerator nor the
denominator. It is not sending anything out. At `resolution=300` a bucket is
one dispatch interval, so this is exactly "drop negative readings"; at
coarser resolutions it is the per-generator net over the bucket, so a battery
that charges more than it discharges within one hour drops out of that hour
entirely. Leaving charging in the denominator would shrink it and inflate
intensity — the wrong direction, and worst exactly when the grid is cleanest.

Clamping the bucket *net* rather than each interval is a deliberate
trade-off: per-interval clamping would be marginally more accurate (it would
still count a battery's discharge intervals inside a net-charging hour), but
it is not computable from the rollup tables, so it would make `resolution=1800`
and `resolution=3600` report different numbers for the same hour with nothing
in the response to explain why. One number per bucket, however it was served,
is the more useful contract.

**Coverage.** Generation from a DUID with *no* published factor is excluded
from both halves of the ratio and disclosed in `coverage`. It is deliberately
**not** treated as zero-emission, which would be a silent lie about a unit we
know nothing about. In practice coverage runs 98–100%; the shortfall is a
handful of pumped-hydro and small hydro units absent from AEMO's factor file
(`PUMP2`, `KAREEYA3`, `KAREEYA4`, `SHPUMP`, `ROWALLAN`, `RUBICON`,
`TULLYSM1`). All are zero- or near-zero-emission, so excluding them biases
intensity very slightly **up**.

### What this is not

These are **estimates**, and they read a few percent high. Two disclosed
reasons:

- AEMO's factors are per MWh **sent out**; dispatch SCADA is **as-generated**.
  Thermal plant carries 5–10% auxiliary load and wind/solar carries almost
  none, so weighting by as-generated over-weights the emitting units. This is
  the bulk of the gap and it is structurally one-directional.
- Factors are static per unit, so part-load heat-rate variation is invisible;
  and excluded unfactored generation (above) is near-zero-emission.

Measured against AEMO's official index on 2026-08-08, over three sample days
and all five regions plus NEM, every comparison sat between **+2.3% and
+9.6%**, with one exception: SA1 on 2026-07-01 read +18.1% — on an
essentially carbon-free day where the official index was 0.0105, i.e. an
absolute difference of 0.0019 tCO₂-e/MWh, about 2 g/kWh. Relative error is
not a meaningful gate at that magnitude; `scripts/reconcile-cdeii.mjs` uses
±10% **or** ±0.02 absolute, whichever is kinder, and prints every region-day
so the raw numbers stay visible.

The estimate is never silently corrected toward the official index. Both
numbers are published side by side at daily resolution so the gap is the
consumer's to see.

**Caching note:** `official` values arrive through the daily CDEII refresh,
while a fully-past window caches for 24 h — so a newly published official
value can take up to a day to appear on an already-cached historical day.

## `GET /api/v2/generators`

Filtered generator reference rows as a **bare JSON array**, ordered by `id`.
Accepts the generator filters above; no time/limit params.

```jsonc
[
  {
    "id": 12, "name": "Banimboola Power Station",
    "participant_name": "AGL Hydro Partnership", "duid": "BAPS",
    "state": "VIC1", "technology_type": "Renewable",
    "technology_description": "Hydro - Gravity", "fuel_type": "Hydro",
    "fuel_description": "Water", "reg_cap": 12.85, "max_cap": 13
  }
]
```

## Deliberately absent (greenfields decisions, 2026-07-24)

The legacy 2015 API is reference-only, not a contract — it has zero
consumers. Dropped from v2 on purpose:

- `sql` / `vars` response fields — information disclosure.
- `time` / `duration` envelope fields — request wall-clock belongs to HTTP
  and observability, not the data payload.
- `num_results` — a row-count leak from the pre-pivot storage model;
  `truncated` carries the actionable signal.
- The `limit` round-up-to-288 behaviour and the 300096 default — an artefact
  of a dead Highcharts view.
- Filter alias piles (`type`/`tech_type`, `start_time`/`start`, …) and their
  accidental precedence — one canonical name + one alias per field.
- Raw `%` as a public wildcard; `scrape_time` as a sort field — storage
  vocabulary leaking into the contract.
- `explain` (EXPLAIN QUERY PLAN passthrough), JSONP, and the Highcharts
  `{ values: { "<id>": [[unixMs, value], …] } }` map.
