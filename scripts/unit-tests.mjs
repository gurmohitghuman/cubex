// Runs the unit tests (tests/unit/*.test.ts), each in its own process with its own fresh database, all
// inside ONE temp folder that is deleted afterwards: a run makes over a hundred databases and nothing
// else removes them (they once filled a disk with thousands of folders). Plain Node, no shell, so it
// runs the same from cmd.exe, PowerShell and sh. Every test runs; the exit code is 1 if any failed.
// Usage: node scripts/unit-tests.mjs [name...]   (only the tests whose file name contains a name)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = 'cubex-unit-';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
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
// Ctrl+C reaches the running test too; start no more of them, and still clean up below.
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { interrupted = true; });

// A test's DB_PATH is its own; os.tmpdir() inside it is the folder above (TMPDIR on macOS and
// Linux, TEMP/TMP on Windows), so whatever else it makes is removed with that folder too.
const run = (file, n) => new Promise(resolve => {
  const db = path.join(fs.mkdtempSync(path.join(dir, `db${n}-`)), 'unit.db');
  const env = { ...process.env, DB_PATH: db, TMPDIR: dir, TEMP: dir, TMP: dir };
  const child = spawn(process.execPath, [tsx, path.join('tests', 'unit', file)], { cwd: root, env, stdio: 'inherit' });
  child.on('error', err => { console.error(err.message); resolve(1); });
  child.on('exit', code => resolve(code ?? 1));
});

const started = Date.now();
const failed = [];
try {
  for (const [n, file] of tests.entries()) {
    if (interrupted) break;
    const status = await run(file, n);
    if (status !== 0) {
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
