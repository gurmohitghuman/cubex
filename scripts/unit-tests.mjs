// Runs the unit tests (tests/unit/*.test.ts), each in its own process with its own fresh database, all
// inside ONE temp folder that is deleted afterwards: a run makes over a hundred databases and nothing
// else removes them (they once filled a disk with thousands of folders). Plain Node, no shell, so it
// runs the same from cmd.exe, PowerShell and sh. Every test runs; the exit code is 1 if any failed.
// A test file still running after its time limit fails by name, and it and every process it started are
// stopped: a file that never ended (once, after all its checks passed, inside Node's own exit) would hold
// the run, here and in CI, until the job's own limit. The slowest file takes a little over 2 minutes in CI.
// Usage: node scripts/unit-tests.mjs [name...]   (only the tests whose file name contains a name)
//        UNIT_FILE_TIMEOUT_S=<seconds> changes each file's limit (300 by default)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = 'cubex-unit-';
const DEFAULT_LIMIT_S = 300;
const WINDOWS = process.platform === 'win32';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
const limitText = process.env.UNIT_FILE_TIMEOUT_S ?? '';
const LIMIT_S = limitText === '' ? DEFAULT_LIMIT_S : Number(limitText);
if (!Number.isFinite(LIMIT_S) || LIMIT_S <= 0) {
  console.error(`UNIT_FILE_TIMEOUT_S must be a number of seconds over 0, not '${limitText}'`);
  process.exit(2);
}
const names = process.argv.slice(2);
const tests = fs.readdirSync(path.join(root, 'tests', 'unit'))
  .filter(f => f.endsWith('.test.ts') && (!names.length || names.some(n => f.includes(n))))
  .sort();
if (!tests.length) {
  console.error(`no unit test file name contains: ${names.join(' ')}`);
  process.exit(2);
}

// Not realpath'd: tsx puts a socket in here and macOS caps socket paths near 104 characters.
const base = path.resolve(os.tmpdir());
const dir = fs.mkdtempSync(path.join(base, PREFIX));
// A test and every process it started: on macOS and Linux the test leads its own process group (below), on
// Windows taskkill follows the process tree. tsx runs each test in a second Node process, so stopping only
// the first would leave the test itself running.
const stopTree = (child, signal) => {
  if (!child.pid) return;
  if (WINDOWS) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try { process.kill(-child.pid, signal); } catch { /* it has ended */ }
};

// Ctrl+C reaches the running test too (passed on to its process group); start no more of them, and still
// clean up below.
let interrupted = false;
let running = null;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    interrupted = true;
    if (running && !WINDOWS) stopTree(running, signal);
  });
}

// A test's DB_PATH is its own; os.tmpdir() inside it is the folder above (TMPDIR on macOS and
// Linux, TEMP/TMP on Windows), so whatever else it makes is removed with that folder too.
const run = (file, n) => new Promise(resolve => {
  const db = path.join(fs.mkdtempSync(path.join(dir, `db${n}-`)), 'unit.db');
  const env = { ...process.env, DB_PATH: db, TMPDIR: dir, TEMP: dir, TMP: dir };
  const child = spawn(process.execPath, [tsx, path.join('tests', 'unit', file)],
    { cwd: root, env, stdio: 'inherit', detached: !WINDOWS });
  running = child;
  let late = false;
  const timer = setTimeout(() => { late = true; stopTree(child, 'SIGKILL'); }, LIMIT_S * 1000);
  const end = status => { clearTimeout(timer); running = null; resolve(status); };
  child.on('error', err => { console.error(err.message); end(1); });
  child.on('exit', code => end(late ? 'late' : code ?? 1));
});

const started = Date.now();
const failed = [];
try {
  for (const [n, file] of tests.entries()) {
    if (interrupted) break;
    const status = await run(file, n);
    if (status === 'late') {
      failed.push(`${file} (did not end within ${LIMIT_S} s)`);
      console.error(`[x] tests/unit/${file} did not end within ${LIMIT_S} s: stopped it and every process it started`);
    } else if (status !== 0) {
      failed.push(file);
      console.error(`[x] tests/unit/${file} failed (exit ${status})`);
    }
  }
} finally {
  // Only ever the folder made above. The retries ride out Windows releasing a finished test's files;
  // a folder that still won't go is reported, and the results below stand.
  if (path.dirname(dir) === base && path.basename(dir).startsWith(PREFIX)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      console.error(`[!] could not remove ${dir} (${err.code})`);
    }
  }
}

const secs = Math.round((Date.now() - started) / 1000);
if (interrupted) {
  console.error(`[stopped] interrupted after ${secs}s`);
  process.exit(130);
}
if (failed.length) {
  console.error(`[done] ${failed.length} of ${tests.length} unit tests failed (${secs}s):\n  ${failed.join('\n  ')}`);
  process.exit(1);
}
console.log(`[done] all ${tests.length} unit tests passed (${secs}s)`);
