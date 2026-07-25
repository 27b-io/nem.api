import { applyD1Migrations, env } from 'cloudflare:test';

// Runs once per test file. Each test file gets its own runtime + storage, but
// tests WITHIN a file share state — the 0.18+ cloudflareTest plugin has no
// per-test isolated-storage snapshots. Specs must reset whatever they mutate.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
