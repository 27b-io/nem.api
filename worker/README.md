# nem-api Worker

Cloudflare Worker for the modernized NEM dispatch SCADA API. Stage 1 (LAB-416):
project scaffold, D1 schema, R2 archive bucket, and the generator reference data
seeded from the repo registration CSV. Stage 2 (LAB-417): the 5-minute Cron
ingest of CURRENT Dispatch SCADA. Stage 3 (LAB-418): the v2 query API;
(LAB-419): the fuel-mix dashboard, served from this same Worker. Stage 4 (LAB-421):
the weekly out-of-band generator-registration refresh from AEMO's live workbook.

## Query API (v2) — public

`src/api.ts` — `GET /api/v2/values`, `GET /api/v2/values/aggregate?group_by=fuel|tech|region`,
and `GET /api/v2/generators`, serving from D1. A **greenfields public
contract** (public until abuse is detected — ray, 2026-07-24; the legacy 2015
API is reference-only): columnar lib-agnostic payload, period-ending NEM-time
buckets (AEST, daily buckets end at AEST midnight), net-MW aggregate
convention, all user input bound (never interpolated), and allowlisted
sort/group_by/resolution identifiers. The pinned request/response contract
lives in [`API.md`](./API.md) — it is owned jointly with the LAB-419
frontend; change both together.

Dev deployment: https://nem-api.raywalker.workers.dev (workers.dev is the dev
environment). Production domain will be **nem.27b.io** — attached at DNS
cutover (LAB-422) via a `routes = [{ pattern = "nem.27b.io", custom_domain = true }]`
entry in `wrangler.toml`; the 27b.io zone must live on the same Cloudflare
account as the Worker.

## Dashboard (LAB-419)

`public/` is served via the Workers **assets** binding on the same Worker/zone
as the API (`wrangler.toml [assets]`) — no separate Pages project, no CORS.
Requests matching a file under `public/` are served as static assets;
everything else falls through to the fetch handler. The hero view is the
OpenNEM-style fuel-mix stacked area over `/api/v2/values/aggregate?group_by=fuel`
with a region filter (five NEM regions, NEM-wide default), light/dark via
daisyUI `data-theme`.

- **Chart**: uPlot 1.6.32, pinned in `package.json` and vendored into
  `public/vendor/` (no CDN at runtime). Stacking is diverging — values are
  net MW per the contract, so each fuel splits into positive/negative halves
  (batteries dip below zero while charging); the pure transform lives in
  `public/stacking.js` and is unit-tested by `test/stacking.spec.ts`.
- **Fuel palette**: OpenNEM-style hue families re-stepped to pass CVD /
  contrast / lightness gates in both themes (dataviz six-checks validator)
  against the exact surfaces in `tailwind.css`. Stack order is part of the
  accessibility mechanism — don't reorder or hand-edit hexes without
  re-validating. Battery has a reserved violet slot for when the LAB-421
  registration refresh makes battery DUIDs resolvable; unknown fuel keys fold
  to gray, never dropped.
- **CSS**: Tailwind v4 + daisyUI 5, one build step
  (`npm run build:css`, input `tailwind.css`). The output
  `public/assets/styles.css` is **generated and committed** — same convention
  as the seed migration — so deploy stays a plain `wrangler deploy`. Rebuild
  and commit whenever `index.html`/`app.js` classes change.
- **Time**: axis and "as at" stamps are NEM market time (AEST, UTC+10, no
  DST) via `Australia/Brisbane` — never `Australia/Sydney`. Buckets are
  period-ending.

## Bindings

| Binding   | Resource                    | Purpose                                          |
|-----------|-----------------------------|--------------------------------------------------|
| `DB`      | D1 database `nem-api-db`    | Hot query window: `generators`, `scada_values`   |
| `ARCHIVE` | R2 bucket `nem-api-archive` | Raw NEMWEB zip archive / deep-history staging    |

## Local dev

```sh
npm install
npm run migrate:local   # apply migrations (schema + generator seed) to local D1
npm run dev             # http://127.0.0.1:8787/health -> {"status":"ok","generators":350}
```

`npm run check` typechecks (src and tests). `npm test` runs the vitest suite in
the real Workers runtime (`@cloudflare/vitest-pool-workers`) against a real D1
with all migrations applied. `/health` queries D1, so a 500 there means the
binding or migrations are broken — that is deliberate.

## SCADA ingest (Cron, every 5 minutes)

`src/ingest.ts`, triggered by the `*/5 * * * *` cron in `wrangler.toml`. Each
run:

1. **Discovers** files on the NEMWEB autoindex
   (`https://nemweb.com.au/Reports/CURRENT/Dispatch_SCADA/`, HTTPS — the legacy
   scraper's plain `http.get` broke on the 307 redirect) with `HTMLRewriter`,
   no jsdom.
2. **Diffs** the listing against the `scrape` ledger and processes only
   not-yet-recorded files, oldest first.
3. Per file: fetch zip → unzip in-Worker (`fflate`; Workers have no native ZIP
   support) → parse `D,DISPATCH,UNIT_SCADA` rows (per-row SETTLEMENTDATE, NEM
   market time = fixed UTC+10) → **upsert** into `scada_values` → archive the
   raw zip to R2 (`current/<filename>`) → record the filename in `scrape`.

To exercise it locally:

```sh
npx wrangler dev --test-scheduled
curl "http://127.0.0.1:8787/__scheduled?cron=*/5+*+*+*+*"
```

### Idempotency & gap handling

Re-runs and overlapping intervals never double-insert: values upsert on the
`(scrape_time, generator_id)` primary key, the R2 key is deterministic (put
skipped when the object exists), and the ledger insert is `OR IGNORE`. The
ledger write happens **last**, so a file that fails part-way stays unrecorded
and is retried on the next run — every earlier step is idempotent, making
whole-file retry always safe.

If cron intervals are missed (deploy freeze, outage), the next run catches up
automatically: discovery diffs the whole CURRENT listing (~2 days of files)
against the ledger. Catch-up is bounded to 50 files per run
(`MAX_FILES_PER_RUN`) — a cold start over the full listing drains in about an
hour of 5-minute runs. Gaps longer than CURRENT's ~2-day window heal via the
ARCHIVE backfill cron (below) as soon as the affected daily zips are published.

Failure handling: one bad file logs and the run continues (per-file
isolation). NEMWEB's WAF rate-limits aggressive clients with 403s, so after 5
*consecutive* failures the run aborts early rather than extending the block —
the next run resumes where it stopped. DUIDs missing from `generators` are
logged per run and their values dropped; the registration refresh below keeps
that set small. `DG_*` (dummy generators) and `RT_*` (RERT reserve-trader
units) are AEMO virtual dispatch units that never appear in the registration
list — they are *expected* to stay in the unknown-DUID log.

## Generator registration refresh (weekly, out-of-band)

The DUID→generator reference data self-updates from AEMO's live
[NEM Registration and Exemption List](https://www.aemo.com.au/-/media/Files/Electricity/NEM/Participant_Information/NEM-Registration-and-Exemption-List.xls)
— deliberately **outside** the 5-minute hot path: units register roughly
monthly, so `.github/workflows/refresh-generators.yml` runs **weekly**
(Mon 19:43 UTC) and on manual dispatch. It calls
`scripts/refresh-generators.mjs`, which

1. fetches the workbook (browser User-Agent — AEMO's WAF 403s plain clients;
   the file is served as `.xls` but is actually OOXML/xlsx, so `fflate` +
   ~80 lines of XML extraction replace a spreadsheet library),
2. maps the **"PU and Scheduled Loads"** sheet to the `generators` schema,
   resolving columns by header name (the sheet has already drifted once:
   `Reg Cap (MW)` → `Reg Cap generation (MW)`) and collapsing unit rows to
   one generator per (station name, DUID) exactly like the seed
   (`scripts/registration.mjs` is the shared logic),
3. writes `refresh-upsert.sql`: `INSERT … ON CONFLICT(duid, name) DO UPDATE`
   — existing rows keep their `id` (historical `scada_values` rows point at
   it), new registrations insert, **nothing is ever deleted**. Generators
   that drop out of AEMO's list simply stay put and stop receiving values.
   (Renamed stations insert a new row — e.g. the seed's "Murray 1/2 Power
   Station" and today's "Murray Power Station" coexist on DUID `MURRAY`;
   ingest keeps attributing MURRAY values to the lowest id.)

The workflow then applies the file with `wrangler d1 execute --remote`
(same `CLOUDFLARE_API_TOKEN` secret as deploy).

Fail-safe: any anomaly — fetch failure, renamed sheet, renamed/missing
column, a suspiciously small list (< 400 generators) — aborts via `assert`
before SQL is written, and a mapping self-check against a captured sample of
the real sheet (`scripts/fixtures/nem-registration-sample.xlsx`) runs before
every refresh *and* in CI (`npm run refresh:check`). A failed run leaves the
existing reference data fully intact; the apply is idempotent, so re-running
after a partial failure is always safe.

Manual refresh — GitHub: Actions → "Refresh generators" → Run workflow, or
`gh workflow run refresh-generators.yml`. Locally:

```sh
npm run refresh:generate   # fetch + parse -> refresh-upsert.sql (gitignored)
npm run refresh:local      # apply to local D1 (or refresh:remote for prod)
```

Note: GitHub auto-disables scheduled workflows after ~60 days without repo
activity; a manual dispatch re-enables the schedule.

## ARCHIVE backfill (Cron, every 15 minutes)

`src/backfill.ts` (LAB-420), on its own cron schedule (`11,26,41,56 * * * *` —
the string in `wrangler.toml` must stay byte-identical to `BACKFILL_CRON`,
which `src/index.ts` dispatches on). NEMWEB's ARCHIVE
(`https://nemweb.com.au/Reports/ARCHIVE/Dispatch_SCADA/`) holds a rolling
~13 months of daily zips, each a zip-of-zips wrapping that day's 288
five-minute files. Per run the backfill diffs the ARCHIVE listing against the
`scrape` ledger (daily filenames — `PUBLIC_DISPATCHSCADA_<YYYYMMDD>.zip` —
share the ledger with the five-minute files; a GLOB keeps them apart) and
ingests up to 4 pending days, oldest first: nested unzip (`fflate`), the same
parse/map path as the CURRENT ingest, idempotent chunked upserts, raw daily
zip archived to R2 at `archive/<filename>`, ledger write last.

From an empty ledger the full archive (~375 days, ~61k values/day at current
DUID coverage) drains in roughly a day of wall time, then each run idles for
the cost of a listing fetch and one ledger query, picking up new daily zips as
ARCHIVE publishes them — the backfill doubles as a standing gap healer for
outages longer than CURRENT's ~2-day window. Days already covered by the
CURRENT ingest overlap harmlessly (same upsert key). Retries read the raw zip
back from R2 instead of re-downloading (the object is only written after a
full successful parse, so it is always valid). Inner five-minute entries that
fail to parse are logged and skipped — the archive is immutable, so a defect
there would otherwise retry forever — while whole-day failures (fetch errors,
zero parsed rows) leave the day unledgered for retry, with the same
consecutive-failure abort as the CURRENT ingest to respect NEMWEB's WAF.

Each ingested day logs a sanity line (`288 file(s), 288 interval(s), N
value(s)`) and a `GAPS:` warning on any deviation. To check progress or
completion against the deployed database:

```sh
# pending == 0 in the run logs means drained; per-day interval coverage:
npx wrangler d1 execute nem-api-db --remote --command "
  SELECT date(scrape_time,'unixepoch','+10 hours') AS day,
         count(DISTINCT scrape_time) AS intervals
  FROM scada_values GROUP BY day HAVING intervals < 288 ORDER BY day"
npx wrangler d1 info nem-api-db   # database size vs the 10GB cap
```

Boundary note for that query: a daily zip covers settlement times 00:05
through 24:00, so each calendar day's midnight interval comes from the
*previous* day's zip — the oldest backfilled day reports 287 and the day after
the newest reports 1. Those two rows are the settlement-date convention, not
gaps. Sizing, measured locally at 19.4 bytes/row: the current window ingests
~23M rows ≈ ~450MB; once the LAB-421 registration refresh makes all ~510
DUIDs resolvable, a full window is ~55M rows ≈ ~1.1GB — inside D1's 10GB cap.

**Re-ingesting after a registration refresh (LAB-421):** values for DUIDs
missing from `generators` are dropped (logged per run), but the raw daily zips
survive in R2. Once the refresh lands, clear the daily ledger entries and the
cron re-ingests every day from R2 (no NEMWEB re-download), filling in the
previously unknown DUIDs — existing rows upsert to the same values:

```sh
npx wrangler d1 execute nem-api-db --remote --command \
  "DELETE FROM scrape WHERE filename GLOB 'PUBLIC_DISPATCHSCADA_????????.zip'"
```

## Migrations

Plain SQL files in `migrations/`, applied in filename order and tracked by
wrangler per-database:

```sh
npm run migrate:local    # local sqlite under .wrangler/
npm run migrate:remote   # the real nem-api-db
```

`0001_init.sql` ports the legacy `api/db/schema.sql`: a flattened `generators`
table (== legacy `flat_generators`; the normalized participant/technology/fuel
tables were only ever read through the flat view, so they were dropped) and
`scada_values` with the legacy `(scrape_time, generator_id)` primary key so
ingest upserts stay idempotent.

## Re-seeding generators

`migrations/0002_seed_generators.sql` is generated — never edit it by hand.
It collapses the 389 physical-unit rows of
`api/db/files/nem_registration_latest.csv` into 350 generators, one per
(station name, DUID), summing unit capacities (matching the legacy
`api/scrape/nem_registration.js` behaviour, minus its reg/max swap bug).

To re-seed from an updated CSV, replace the CSV then:

```sh
npm run seed:generate    # rewrites migrations/0002_seed_generators.sql
npm run migrate:local    # or migrate:remote
```

If `0002` was already applied, wrangler will not re-run it — bump the new seed
into a fresh migration file instead (`cp` the regenerated file to
`migrations/000N_reseed_generators.sql`).

**DELETE + reinsert is only safe while `scada_values` is empty.** The generated
seed starts with `DELETE FROM generators`, which reassigns ids — acceptable
for the one-time bootstrap, but once ingest has written value rows keyed by
`generator_id`, never re-run the seed against a live database. Ongoing updates
are the registration refresh's job (see above): it upserts on the
`(duid, name)` identity (`generators_duid_name` — DUID alone is not unique)
so ids are preserved and nothing is deleted.

## Deploy

CD: every push to the default branch (`master`, or `main` if ever renamed) runs
`.github/workflows/deploy.yml` — typecheck, apply D1 migrations, `wrangler deploy`,
then smoke-check `/health`. It needs one repo Actions secret:

- `CLOUDFLARE_API_TOKEN` — API token scoped to the account, with
  **Workers Scripts: Edit** and **D1: Edit** (Cloudflare dash → My Profile →
  API Tokens → "Edit Cloudflare Workers" template + add D1 Edit). The account id
  is pinned in `wrangler.toml`, so no account permission is needed beyond that.

Manual deploy still works:

```sh
npm run deploy
curl https://nem-api.raywalker.workers.dev/health
```
