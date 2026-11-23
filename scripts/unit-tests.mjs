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
const MAX_LIMIT_S = 2_147_483; // Node's longest timer, in whole seconds
const WINDOWS = process.platform === 'win32';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
const limitText = process.env.UNIT_FILE_TIMEOUT_S ?? '';
const LIMIT_S = limitText === '' ? DEFAULT_LIMIT_S : Number(limitText);
if (!Number.isFinite(LIMIT_S) || LIMIT_S <= 0 || LIMIT_S > MAX_LIMIT_S) {
  console.error(`UNIT_FILE_TIMEOUT_S must be a number of seconds over 0 and up to ${MAX_LIMIT_S}, not '${limitText}'`);
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
// A test and every process it started. tsx runs each test in a second Node process, so stopping only the
// first would leave the test itself running. On Windows taskkill follows the process tree. On macOS and Linux
// the tree comes from one look at the process table (ps), parents first; a process started after that look is
// missed. The test stays in the runner's process group, so a signal to the whole run, even a SIGKILL that
// ends the runner at once, still reaches the test and what it started. Says whether it reached the whole tree.
const treeOf = pid => {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  if (ps.status !== 0) return null;
  const children = new Map();
  for (const line of ps.stdout.split('\n')) {
    const [id, parent] = line.trim().split(/\s+/).map(Number);
    if (id && parent) children.set(parent, [...(children.get(parent) ?? []), id]);
  }
  const tree = [pid];
  for (let i = 0; i < tree.length; i++) tree.push(...(children.get(tree[i]) ?? []));
  return tree;
};
const stopTree = (child, signal) => {
  if (!child.pid) return true;
  if (WINDOWS) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return true;
  }
  const tree = treeOf(child.pid);
  if (!tree) console.error(`[!] could not list processes with ps: ${signal} went to process ${child.pid} alone`);
  for (const pid of tree ?? [child.pid]) {
    try { process.kill(pid, signal); } catch { /* it has ended */ }
  }
  return tree !== null;
};

// Linux, for the log: what each process of a late test is doing before it is stopped. Each thread's name, state,
// the kernel function it waits in, its system call, and its CPU time over one second, which tells busy work from
// waiting. Reading a thread's system call is allowed to an ancestor of the process only: the runner is one.
const SYSCALLS = {
  x64: { 0: 'read', 7: 'poll', 35: 'nanosleep', 61: 'wait4', 202: 'futex', 232: 'epoll_wait', 281: 'epoll_pwait' },
  arm64: { 22: 'epoll_pwait', 63: 'read', 73: 'ppoll', 98: 'futex', 101: 'nanosleep', 260: 'wait4' },
}[process.arch] ?? {};
const readProc = file => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return '?'; } };
const threadsOf = pid => {
  let tids = [];
  try { tids = fs.readdirSync(`/proc/${pid}/task`); } catch { /* it has ended */ }
  return tids.map(tid => {
    const at = `/proc/${pid}/task/${tid}`;
    const stat = readProc(`${at}/stat`);
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { tid, at, state: f[0], cpu: Number(f[11]) + Number(f[12]) };
  });
};
const printThreads = async pids => {
  const before = new Map(pids.flatMap(threadsOf).map(t => [t.at, t.cpu]));
  await new Promise(res => setTimeout(res, 1000));
  for (const pid of pids) {
    const cmd = readProc(`/proc/${pid}/cmdline`).replace(/\0/g, ' ').trim();
    console.error(`[threads] process ${pid}: ${cmd.length > 120 ? `...${cmd.slice(-120)}` : cmd}`);
    const alike = new Map(); // threads doing the same thing share a line
    for (const t of threadsOf(pid)) {
      const call = readProc(`${t.at}/syscall`).split(' ')[0];
      const line = `${readProc(`${t.at}/comm`)}: ${t.state}, in ${readProc(`${t.at}/wchan`)}, syscall `
        + `${SYSCALLS[call] ?? call}, CPU +${t.cpu - (before.get(t.at) ?? t.cpu)} ticks in 1 s`;
      alike.set(line, (alike.get(line) ?? 0) + 1);
    }
    for (const [line, n] of alike) console.error(`  ${n > 1 ? `${n} threads, ` : ''}${line}`);
  }
};

// A signal to the runner alone is passed on to the running test and every process it started (Ctrl+C reaches
// them all anyway, as one process group); start no more tests, and still clean up below.
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
    { cwd: root, env, stdio: 'inherit' });
  running = child;
  let late = null;
  let ended = false;
  const timer = setTimeout(async () => {
    late = 'late';
    if (process.platform === 'linux') await printThreads(treeOf(child.pid) ?? [child.pid]);
    if (!ended) late = stopTree(child, 'SIGKILL') ? 'late' : 'late-part';
  }, LIMIT_S * 1000);
  const end = status => { ended = true; clearTimeout(timer); running = null; resolve(status); };
  child.on('error', err => { console.error(err.message); end(1); });
  child.on('exit', code => end(late ?? code ?? 1));
});

const started = Date.now();
const failed = [];
try {
  for (const [n, file] of tests.entries()) {
    if (interrupted) break;
    const status = await run(file, n);
    if (status === 'late' || status === 'late-part') {
      failed.push(`${file} (did not end within ${LIMIT_S} s)`);
      const all = status === 'late' ? ': stopped it and every process it started' : '';
      console.error(`[x] tests/unit/${file} did not end within ${LIMIT_S} s${all}`);
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
