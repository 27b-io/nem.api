# nem-api v2 — data contract

Pinned payload contract for the query API (LAB-418), owned jointly with the
LAB-419 frontend. Breaking changes to the shapes below require touching both
sides deliberately — update this file in the same PR.

All endpoints: `GET`, JSON, CORS `*`, gzip via Cloudflare. Times are **unix
seconds UTC** unless a field says otherwise. Errors are
`{ "error": "<message>" }` with a 4xx/5xx status. The legacy `sql` / `vars`
response fields are gone and will not return (information disclosure).

## `GET /api/v2/values`

Per-generator generation (MW), pivoted onto a shared time axis.

```jsonc
{
  "time": 1784901600123,      // request receive time, unix MILLIseconds (legacy field)
  "duration": 12,             // server processing ms (legacy field)
  "num_results": 5,           // data points returned by the query (before pivot)
  "start": 1784901600,        // resolved window start (null if only `time`/`time_end` given)
  "end": 1784902200,          // resolved window end (null when open-ended "from now")
  "resolution": 300,          // bucket width in seconds actually used
  "timestamps": [1784901600, 1784901900, 1784902200],  // shared x-axis, ascending
  "series": [
    {
      "id": 12,               // generators.id
      "duid": "BAPS",         // AEMO dispatch unit id
      "name": "Banimboola Power Station",
      "fuel": "Hydro",        // generators.fuel_type (series coloring)
      "values": [10, 12, 14]  // MW, aligned to `timestamps`; null = no sample in bucket
    }
  ]
}
```

`values[i]` is the **mean MW over bucket `timestamps[i]`** (rounded to 4 dp).
Buckets are UTC-aligned (`floor(scrape_time / resolution) * resolution`).
uPlot consumption is `[timestamps, ...series.map(s => s.values)]`.

If `num_results` equals the effective limit the response was truncated —
narrow the filters, coarsen `resolution`, or page with `offset`.

### Query parameters

**Time window** (legacy grammar preserved):

| Param | Meaning |
|---|---|
| `time` | exact dispatch interval (unix seconds or ISO string) |
| `time_start` / `start_time` / `start` | window start (unix seconds or ISO) |
| `time_end` / `end_time` / `end` | window end (unix seconds or ISO) |
| `minutes` / `hours` / `days` / `weeks` / `months` | relative window; first one present wins, in that order |

Relative-window combinations (legacy semantics): no start/end → from now,
counting back (open-ended end); with `time_start` → `[start, start+window]`
(a given `time_end` is ignored); with only `time_end` → `[end-window, end]`.
`months` is calendar arithmetic, clamped to month end. **No time params at
all → the last 24 hours** (v2 change; legacy scanned from epoch 0).

**Bucketing**: `resolution` — one of `300`, `1800`, `3600`, `86400` seconds.
Unset → auto by window span: ≤3 days → 300, ≤14 days → 1800, ≤90 days → 3600,
else 86400.

**Generator filters** (also on `generators` and `values/aggregate`; aliases
listed in precedence order):

| Column | Params |
|---|---|
| `state` | `state` |
| `fuel_type` | `fuel`, `fuel_type` |
| `fuel_description` | `fuel_desc`, `fuel_description` |
| `technology_type` | `tech_type`, `tech`, `type` |
| `technology_description` | `tech_desc`, `tech_description` |
| `duid` | `duid` (v2 addition) |

Operator inference per value (legacy grammar): contains `,` → `IN` over the
split values; contains `*` or `%` → `LIKE` (`*` becomes `%`); otherwise `=`.
All values are bound parameters — never interpolated.

**Paging / order**: `limit` (1–300000, rounded **up** to a multiple of 288 — a
generator-day of 5-min samples; invalid/absent → 300096, the legacy effective
default), `offset` (default 0), `sort`/`order` = `<field>[,asc|desc]` with
field one of `time`, `scrape_time`, `generator_id`, `value` (allowlisted;
anything else is a 400 — the legacy API interpolated this raw).

## `GET /api/v2/values/aggregate?group_by=fuel|tech|state`

Generation totals bucketed by fuel type, technology type, or state — feeds the
fuel/technology-mix stacked-area chart. Same envelope, params, and alignment
rules as `values`, plus `group_by` (required). `sort` is not supported here;
order is always time-ascending.

```jsonc
{
  "time": 1784901600123,
  "duration": 18,
  "num_results": 2,
  "group_by": "fuel",
  "start": 1784901600,
  "end": 1784901900,
  "resolution": 1800,
  "timestamps": [1784901600],
  "series": [
    { "key": "Fossil", "values": [1300] },   // key = group value ('' when NULL)
    { "key": "Hydro",  "values": [15] }
  ]
}
```

`values[i]` is the mean over the bucket of the **per-interval summed MW**
across the group's generators (mean-of-sums — stays correct when a unit
misses an interval inside the bucket).

## `GET /api/v2/generators`

Filtered generator reference rows as a **bare JSON array** (legacy shape),
ordered by `id`. Accepts the generator filters above; no time/limit params.

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

## Not ported from legacy (deliberate)

- `sql` / `vars` response fields — information disclosure.
- `explain` (EXPLAIN QUERY PLAN passthrough) — debug aid, no concrete need.
- The Highcharts `{ values: { "<id>": [[unixMs, value], …] } }` map — replaced
  by the columnar shape above (LAB-418/LAB-419 joint decision, 2026-07-21).
- JSONP — dead tech; CORS covers cross-origin use.
