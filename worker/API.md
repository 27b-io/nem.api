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
