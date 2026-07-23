# nem-api Worker

Cloudflare Worker for the modernized NEM dispatch SCADA API. Stage 1 (LAB-416):
project scaffold, D1 schema, R2 archive bucket, and the generator reference data
seeded from the repo registration CSV. SCADA ingest, query endpoints, and the
frontend land in later stages.

Dev deployment: https://nem-api.raywalker.workers.dev (workers.dev is the dev
environment; production routes attach at DNS cutover).

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

`npm run check` typechecks. `/health` queries D1, so a 500 there means the
binding or migrations are broken — that is deliberate.

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
`migrations/000N_reseed_generators.sql`; it starts with `DELETE FROM generators`
so it fully replaces the table). The live `.xls` registration refresh is a
separate later stage (LAB-421).

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
