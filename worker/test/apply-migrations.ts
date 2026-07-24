import { applyD1Migrations, env } from 'cloudflare:test';

// Runs once per test file. NOTE: the cloudflareTest plugin (0.18.x) has no
// per-test isolated storage — tests within a file share one D1, so specs must
// clean up (or key) their own writes.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
