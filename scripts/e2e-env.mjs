// The settings scripts/e2e-harness.mjs gives the mock treg, the server and the specs: a throwaway data
// dir, secrets the server generates there, and short timings so specs don't wait. A value already in
// the environment wins, except the data paths and secrets.
import path from 'node:path';

export function testEnv(env, { testDir, port, tregBase, receiverPort }) {
  return {
    ...env,
    DB_PATH: path.join(testDir, 'cubex-e2e.db'),
    JOBS_DB_PATH: path.join(testDir, 'jobs-e2e.db'),
    // Empty, so a server/.env can't supply them: the server generates both on first boot inside
    // the test dir, which exercises that path on every run.
    JWT_SECRET: '',
    APP_ENCRYPTION_KEY: '',
    // Webhook URLs come back absolute, so specs can POST to them directly.
    PUBLIC_URL: `http://localhost:${port}`,
    // Specs sign in (and deliberately fail sign-ins) far more often than a person does; lift the
    // instance-wide failed-attempt budget for the harness only.
    LOGIN_RATE_MAX: env.LOGIN_RATE_MAX || '100000',
    // Enables the transfer_rows / transform_column MCP tools so their specs run.
    MCP_EFFICIENT_ROWS_ENABLED: env.MCP_EFFICIENT_ROWS_ENABLED || '1',
    // Enrichments talk to a mock treg (tests/mock-treg), never the real treg.to, except in the live
    // smoke. TREG_BASE_URL is an operator setting (never user input); specs drive the mock's state
    // through E2E_TREG.
    TREG_BASE_URL: tregBase,
    // Auto-run looks for rows to fill every half second here (15 s by default), and specs move
    // "today" forward through this file to test daily caps (lib/clock.ts).
    AUTORUN_SWEEP_MS: env.AUTORUN_SWEEP_MS || '500',
    // Setups being used move on to their next step this often (3 s in production).
    SETUP_SWEEP_MS: env.SETUP_SWEEP_MS || '500',
    AUTORUN_USER_YIELD_MS: env.AUTORUN_USER_YIELD_MS || '6000',
    // List results become rows on this beat (5 s in production).
    ENRICH_LIST_DRAIN_MS: env.ENRICH_LIST_DRAIN_MS || '500',
    // Older answers of rows enriched again are pruned on this beat (30 s in production).
    ANSWER_PRUNE_SWEEP_MS: env.ANSWER_PRUNE_SWEEP_MS || '500',
    // Enrichment runs take 5 rows at once here (20 in production): the limit, pause and cancel specs
    // need rows still waiting when they act on a run of a few rows.
    ENRICH_DEFAULT_CONCURRENCY: env.ENRICH_DEFAULT_CONCURRENCY || '5',
    CUBEX_TEST_CLOCK_FILE: path.join(testDir, 'test-clock'),
    // HTTP column retries and run webhook notices wait less here (1 s and 10 s first waits in
    // production), and run webhooks are sent on a faster beat.
    HTTP_RETRY_BASE_MS: env.HTTP_RETRY_BASE_MS || '100',
    RUN_HOOK_RETRY_BASE_MS: env.RUN_HOOK_RETRY_BASE_MS || '300',
    RUN_HOOK_SWEEP_MS: env.RUN_HOOK_SWEEP_MS || '200',
    // Specs reach a receiver they start on 127.0.0.1 through the real outbound path (SSRF guard
    // included) via names under .cubex-e2e.invalid (tests/e2e/net-shim.cjs).
    E2E_RECEIVER_PORT: receiverPort,
  };
}
