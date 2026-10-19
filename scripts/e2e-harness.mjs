// e2e-harness.mjs - one-command Playwright E2E run (npm run e2e).
//
// Boots the PRODUCTION build against a throwaway data directory (server/data/e2e/), runs first-time
// setup to set the account password, runs the specs, and tears everything down. The real
// server/data/cubex.db is NEVER touched: the test DB lives in its own directory, so even the secrets
// the server generates on first boot (.jwt-secret, .encryption-key) land there.
//
// Usage (arguments after `--` reach this script):
//   npm run e2e                           # build + run the data-consistency suite
//   E2E_SPEC=tests/e2e npm run e2e        # the whole suite
//   npm run e2e -- --no-build             # skip the build (use existing dist/)
//   npm run e2e -- -g "H3"                # pass-through Playwright args (grep, --headed, ...)
// PowerShell sets a variable for the whole window, so clear it after:
//   $env:E2E_SPEC='tests/e2e'; npm run e2e; Remove-Item Env:E2E_SPEC
//
// Env overrides: E2E_PORT (default 3099), E2E_TREG_PORT (the mock treg, default 3098),
// E2E_RECEIVER_PORT (the local receiver specs start, default 3097), E2E_SPEC (default the
// data-consistency specs; a Playwright path filter or a concrete .spec.ts path), E2E_INSTANCE (a
// number: data in server/data/e2e-<n> and logs tagged with it, so several harnesses can run at once;
// see scripts/e2e-parallel.mjs). Logs go to cubex-e2e-*.log in the OS temp folder.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testEnv } from './e2e-env.mjs';
import { listening, npmRun, removeDir, sleep, start, stop, tail, waitUntilUp } from './e2e-procs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const env = process.env;
const PORT = env.E2E_PORT || '3099';
const TREG_PORT = env.E2E_TREG_PORT || '3098';
const RECEIVER_PORT = env.E2E_RECEIVER_PORT || '3097';
// Forward slashes: Playwright reads the filter as a regex, where a Windows "\e" would be an escape.
const SPEC = (env.E2E_SPEC || 'data-consistency').replaceAll('\\', '/').replace(/^\.\//, '');
const INSTANCE = env.E2E_INSTANCE || '';
const DATA_DIR = path.join(ROOT, 'server', 'data');
const TEST_DIR = path.join(DATA_DIR, INSTANCE ? `e2e-${INSTANCE}` : 'e2e');
const logFile = name => path.join(os.tmpdir(), `cubex-e2e-${name}${INSTANCE ? `-${INSTANCE}` : ''}.log`);
const [BUILD_LOG, TREG_LOG, SERVER_LOG] = ['build', 'treg', 'server'].map(logFile);
const TEST_PASSWORD = 'password123'; // keep in sync with TEST_PASSWORD in tests/e2e/helpers.ts
const LIVE_SPEC = 'tests/e2e/enrich-live-smoke.spec.ts';
const DO_BUILD = !process.argv.includes('--no-build');
const PW_ARGS = process.argv.slice(2).filter(arg => arg !== '--no-build');

class Refused extends Error {}
const fail = (message, log) => { throw new Refused(log ? `${message}\n${tail(log, 20)}` : message); };

const children = [];
let ownsTestDir = false;
let cleaning = null;
let stopping = false;
// A child main() starts once teardown has begun (it was past an await) is stopped with the rest.
const track = child => {
  children.push(child);
  if (cleaning) fail('stopped');
  return child;
};
// Once: stop whatever was started, then remove the test data (only once this run owns TEST_DIR).
// A folder that won't go is reported, not failed: the run's result stands, the next run clears it.
const cleanup = () => cleaning ??= (async () => {
  while (children.some(child => !child.done)) await Promise.all(children.map(child => stop(child)));
  const err = ownsTestDir && removeDir(TEST_DIR);
  if (err) console.log(`[!] could not remove ${TEST_DIR} (${err.code}); the next run clears it`);
})();
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[stop] ${signal} - tearing down server + test data`);
    // Ctrl+C reached the server, mock treg and Playwright too: give them a moment to finish on their
    // own (Playwright reports what it was doing), then stop whatever is left.
    if (signal === 'SIGINT') await Promise.race([Promise.all(children.map(child => child.exited)), sleep(5000)]);
    await cleanup();
    process.exit(code);
  });
}

async function main() {
  if (INSTANCE && !/^\d+$/.test(INSTANCE)) fail('E2E_INSTANCE must be a number');
  // Safety: the test data must live in its own directory, never next to cubex.db.
  if (!/^e2e(-\d+)?$/.test(path.relative(DATA_DIR, TEST_DIR))) fail(`refusing: unexpected TEST_DIR ${TEST_DIR}`);
  if (SPEC.endsWith('.spec.ts') && !fs.existsSync(SPEC)) fail(`spec not found: ${SPEC}`);
  // Playwright is deliberately not in package.json (CONTRIBUTING.md says how to add it).
  let playwrightCli;
  try {
    playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/cli');
  } catch {
    fail('Playwright is missing: run `npm install --no-save @playwright/test`, then `npx playwright install chromium`');
  }

  // The live smoke (tests/e2e/enrich-live-smoke.spec.ts): with CUBEX_SMOKE_TREG_TOKEN set, enrichments
  // go to the real treg and spend cents of that team's balance, so that spec runs alone; every other
  // spec expects the mock.
  const live = Boolean(env.CUBEX_SMOKE_TREG_TOKEN);
  if (live && SPEC !== LIVE_SPEC) fail(`CUBEX_SMOKE_TREG_TOKEN is set: run only E2E_SPEC=${LIVE_SPEC}`);

  // Another run (or a stale server) on our ports would be adopted as ours, and this run's cleanup
  // would delete its data. Check before touching anything.
  for (const [host, port] of [['localhost', PORT], ['127.0.0.1', TREG_PORT]]) {
    if (await listening(host, port)) fail(`${host}:${port} is in use (another e2e run?). Set E2E_PORT/E2E_TREG_PORT.`);
  }
  ownsTestDir = true;
  console.log(`[logs] ${logFile('*')}`);

  if (DO_BUILD) {
    console.log('[build] client + server ...');
    const build = track(npmRun('build', BUILD_LOG));
    if (await build.exited !== 0) fail('build failed:', BUILD_LOG);
  }
  if (!fs.existsSync('server/dist/index.js')) fail('server/dist missing - run without --no-build');
  if (!fs.existsSync('client/dist/index.html')) fail('client/dist missing - run without --no-build');

  const stale = removeDir(TEST_DIR);
  if (stale) fail(`could not clear ${TEST_DIR} (${stale.code}): is another run using it?`);
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const tregBase = live ? env.CUBEX_SMOKE_TREG_BASE || 'https://treg.to' : `http://127.0.0.1:${TREG_PORT}`;
  const runEnv = testEnv(env, { testDir: TEST_DIR, port: PORT, tregBase, receiverPort: RECEIVER_PORT });

  if (!live) {
    console.log(`[boot] mock treg on :${TREG_PORT} ...`);
    const tregArgs = ['tests/mock-treg/server.mjs', TREG_PORT];
    const treg = track(start(process.execPath, tregArgs, { env: runEnv, logFile: TREG_LOG }));
    const state = await waitUntilUp(`${tregBase}/health`, treg, { tries: 60, everyMs: 250 });
    if (state === 'died') fail('mock treg died:', TREG_LOG);
    if (state !== 'up') fail('mock treg never became ready', TREG_LOG);
  } else {
    console.log(`[live] enrichments go to ${tregBase} (live smoke)`);
  }

  console.log(`[boot] prod server on :${PORT} (data: ${path.relative(ROOT, TEST_DIR)}) ...`);
  // NODE_OPTIONS reads a double-quoted value with backslash escapes: JSON quoting keeps a path with
  // spaces or Windows backslashes whole.
  const shim = JSON.stringify(path.join(ROOT, 'tests', 'e2e', 'net-shim.cjs'));
  const serverEnv = { ...runEnv, NODE_ENV: 'production', PORT, NODE_OPTIONS: `--require ${shim}` };
  const server = track(start(process.execPath, ['server/dist/index.js'], { env: serverEnv, logFile: SERVER_LOG }));
  // A boot takes 2-3 s, but a first boot on Windows sometimes stalls 20-45 s creating the new database
  // files; the cap only decides how soon a server that will never come up is reported.
  process.stdout.write('[wait] server');
  const state = await waitUntilUp(`http://localhost:${PORT}/api/health`, server, {
    tries: 120, everyMs: 500, onPoll: () => process.stdout.write('.'),
  });
  console.log(state === 'up' ? ' - up' : state === 'died' ? ' - DIED' : '');
  if (state === 'died') fail('server exited during boot:', SERVER_LOG);
  if (state !== 'up') fail('server never became ready', SERVER_LOG);

  console.log('[setup] first-time password ...');
  const setup = await fetch(`http://localhost:${PORT}/api/auth/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: TEST_PASSWORD }),
  }).catch(() => null);
  if (setup?.status !== 200) fail(`setup failed: HTTP ${setup?.status ?? 'no answer'}`, SERVER_LOG);

  console.log(`[test] ${SPEC} ...`);
  const playwright = track(start(process.execPath, [playwrightCli, 'test', SPEC, '--reporter=list', ...PW_ARGS], {
    env: { ...runEnv, E2E_BASE: `http://localhost:${PORT}`, E2E_TREG: tregBase,
      E2E_CLOCK_FILE: runEnv.CUBEX_TEST_CLOCK_FILE },
  }));
  const rc = await playwright.exited;
  console.log(`[done] exit ${rc} - tearing down server + test data`);
  return rc;
}

let rc = 1;
try {
  rc = await main();
} catch (err) {
  if (!stopping) console.log(err instanceof Refused ? `[x] ${err.message}` : err);
} finally {
  await cleanup();
}
if (!stopping) process.exit(rc);
