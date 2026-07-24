# nem-api Worker

Cloudflare Worker for the modernized NEM dispatch SCADA API. Stage 1 (LAB-416):
project scaffold, D1 schema, R2 archive bucket, and the generator reference data
seeded from the repo registration CSV. Stage 2 (LAB-417): the 5-minute Cron
ingest of CURRENT Dispatch SCADA. Stage 4 (LAB-421): the weekly out-of-band
generator-registration refresh from AEMO's live workbook. Query endpoints and
the frontend land in other stages.

Dev deployment: https://nem-api.raywalker.workers.dev (workers.dev is the dev
environment). Production domain will be **nem.27b.io** — attached at DNS
cutover (LAB-422) via a `routes = [{ pattern = "nem.27b.io", custom_domain = true }]`
entry in `wrangler.toml`; the 27b.io zone must live on the same Cloudflare
account as the Worker.

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
hour of 5-minute runs. Gaps longer than CURRENT's ~2-day window need the
ARCHIVE backfill (LAB-420).

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
