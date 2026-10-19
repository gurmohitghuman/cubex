// Child processes for the e2e scripts (e2e-harness.mjs, e2e-parallel.mjs), the same on Windows, macOS
// and Linux: start one with its output in a log file, wait until it answers, stop it together with
// everything it started, and remove a data folder once nothing holds its files open.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

export const IS_WINDOWS = process.platform === 'win32';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Starts a process with stdout + stderr in logFile (or this terminal without one). `exited` resolves
// to its exit code; `done` turns true when it has exited. A `shell` command is a fixed string.
export function start(command, args, { env = process.env, logFile, shell = false } = {}) {
  const fd = logFile ? fs.openSync(logFile, 'w') : null;
  try {
    const child = spawn(command, args, { env, shell, stdio: fd === null ? 'inherit' : ['ignore', fd, fd] });
    child.done = false;
    child.exited = new Promise(resolve => {
      child.once('error', err => { console.error(err.message); child.done = true; resolve(1); });
      child.once('exit', code => { child.done = true; resolve(code ?? 1); });
    });
    return child;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// `npm run <script>` with its output in logFile. Under npm, npm_execpath is npm's own CLI script, run
// here with this Node (no shell, no npm.cmd); started some other way, a shell finds npm.
export function npmRun(script, logFile) {
  const cli = process.env.npm_execpath || '';
  return /\.[cm]?js$/.test(cli)
    ? start(process.execPath, [cli, 'run', script], { logFile })
    : start(`npm run ${script}`, [], { logFile, shell: true });
}

// True when url answers 2xx (what `curl -f` checked), false on anything else or after 2 s.
export async function answers(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

// True when something accepts connections on host:port, or stays silent for 2 s: busy or not, the
// port isn't free, and a run that took it would delete another run's data.
export const listening = (host, port) => new Promise(resolve => {
  const socket = net.connect({ host, port: Number(port) });
  const settle = inUse => { socket.destroy(); resolve(inUse); };
  socket.setTimeout(2000, () => settle(true));
  socket.once('connect', () => settle(true));
  socket.once('error', () => settle(false));
});

// Polls url until it answers: 'up', 'died' when child exits first, or 'timeout' after `tries` polls.
export async function waitUntilUp(url, child, { tries, everyMs, onPoll = () => {} }) {
  for (let i = 0; i < tries; i++) {
    if (child.done) return 'died';
    if (await answers(url)) return 'up';
    onPoll();
    await sleep(everyMs);
  }
  return !child.done && await answers(url) ? 'up' : 'timeout';
}

// Stops a child and everything it started (the server forks Sidequest's runner, Playwright its
// browser). Off Windows that's SIGTERM, which the server catches to shut down cleanly; Windows has no
// signal to catch, so there the whole tree is ended at once.
export async function stop(child, waitMs = 6000) {
  if (!child || child.done) return;
  if (IS_WINDOWS) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
  await Promise.race([child.exited, sleep(waitMs)]);
  if (!child.done) {
    child.kill('SIGKILL');
    await child.exited;
  }
}

// Removes a folder; returns the error when it couldn't (null when it did). Windows refuses to delete a
// file a process still has open, and a just-ended process lets go of its files a moment after it
// exits, so it retries for a few seconds first.
export function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    return null;
  } catch (err) {
    return err;
  }
}

// The last n lines of a log file ('' when it can't be read).
export function tail(file, n) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-n).join('\n');
  } catch {
    return '';
  }
}
