// e2e-parallel.mjs - the whole e2e suite in N parts at once (npm run e2e:all; default 3).
//
// Builds once, then starts N harnesses (scripts/e2e-harness.mjs), each with its own server, mock
// treg, ports and data dir (server/data/e2e-<n>), each running its share of the spec files
// (Playwright --shard). Specs still run one at a time inside a part, since they share that part's
// one account. Uses about N times the CPU and memory of one run for a fraction of the time.
//
// Usage:
//   npm run e2e:all                   # build + the whole suite in 3 parts
//   E2E_SHARDS=4 npm run e2e:all      # 4 parts
//   npm run e2e:all -- --no-build     # skip the build (use existing dist/)
// PowerShell sets a variable for the whole window, so clear it after:
//   $env:E2E_SHARDS='4'; npm run e2e:all; Remove-Item Env:E2E_SHARDS
//
// Env overrides: E2E_SHARDS (default 3), E2E_SPEC (default tests/e2e), E2E_PARALLEL_PORT (default
// 3300; part n uses ports base+10n .. base+10n+2). Each part's output goes to cubex-e2e-part-<n>.log
// in the OS temp folder, printed when it fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IS_WINDOWS, npmRun, start, tail } from './e2e-procs.mjs';

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SHARDS = process.env.E2E_SHARDS || '3';
const SPEC = process.env.E2E_SPEC || 'tests/e2e';
const BASE_PORT = Number(process.env.E2E_PARALLEL_PORT || 3300);
const args = process.argv.slice(2);

const refuse = message => {
  console.log(`[x] ${message}`);
  process.exit(1);
};
const unknown = args.find(arg => arg !== '--no-build');
if (unknown) refuse(`unknown argument: ${unknown} (use npm run e2e for Playwright args)`);
if (!/^[1-9]\d*$/.test(SHARDS)) refuse('E2E_SHARDS must be a number from 1');
const total = Number(SHARDS);

if (!args.includes('--no-build')) {
  console.log('[build] client + server ...');
  const log = path.join(os.tmpdir(), 'cubex-e2e-build.log');
  if (await npmRun('build', log).exited !== 0) {
    refuse(`build failed:\n${tail(log, 20)}`);
  }
}

const parts = [];
let stopping = false;
// Ctrl+C reaches every part already (same terminal); a signal sent to this script alone is passed
// on. Either way each part tears down its own server and data, and this waits for that. On Windows
// the parts always got the Ctrl+C themselves, and ending one from here would skip its teardown.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    if (!IS_WINDOWS) for (const part of parts) if (!part.child.done) part.child.kill('SIGTERM');
    await Promise.all(parts.map(part => part.child.exited));
    console.log(`[stop] ${signal} - every part stopped`);
    process.exit(130);
  });
}

// An E2E_SPEC left set (PowerShell keeps it for the whole window) runs less than the whole suite.
const partial = SPEC === 'tests/e2e' ? '' : ' (E2E_SPEC is set: NOT the whole suite)';
console.log(`[parts] ${SPEC} in ${total} parts${partial}`);
const started = Date.now();
for (let n = 1; n <= total; n++) {
  const port = BASE_PORT + 10 * n;
  const log = path.join(os.tmpdir(), `cubex-e2e-part-${n}.log`);
  const env = {
    ...process.env, E2E_INSTANCE: String(n), E2E_SPEC: SPEC,
    E2E_PORT: String(port), E2E_TREG_PORT: String(port + 1), E2E_RECEIVER_PORT: String(port + 2),
  };
  // Each part cleans only its own Playwright output folder.
  const harnessArgs = ['scripts/e2e-harness.mjs', '--no-build', `--shard=${n}/${total}`,
    `--output=test-results/part-${n}`];
  parts.push({ n, log, child: start(process.execPath, harnessArgs, { env, logFile: log }) });
  console.log(`[part ${n}/${total}] started on :${port}`);
}

let failed = false;
for (const { n, log, child } of parts) {
  const rc = await child.exited;
  if (stopping) break; // the signal handler reports and exits
  // The list reporter ends with lines like "  12 passed (2.1m)" and "  1 failed".
  const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const summary = text.split(/\r?\n/)
    .filter(line => /^ +\d+ (passed|failed|flaky|skipped|did not run)/.test(line))
    .map(line => line.replace(/ +/g, ' '))
    .join(',');
  console.log(`[part ${n}/${total}] exit ${rc}:${summary || ' no summary'}`);
  if (rc !== 0) {
    failed = true;
    console.log(`----- part ${n} output (last 60 lines; full: ${log}) -----`);
    console.log(tail(log, 60));
    console.log('-----');
  }
}

if (!stopping) {
  console.log(`[done] ${Math.round((Date.now() - started) / 1000)}s, ${failed ? 'FAILED' : 'all parts passed'}`);
  process.exit(failed ? 1 : 0);
}
