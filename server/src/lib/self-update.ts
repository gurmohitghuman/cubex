// Settings' "Update now" (routes/settings-version.ts, plans/settings-update-now.md): Cubex updates itself as
// `cubex update` does, started where the service manager won't stop it with Cubex, since the update stops Cubex
// first. bin/cubex-update-run.sh (.ps1 on Windows), copied to the install folder, holds update.lock with its pid,
// writes the update's output to update.log and, once the update ends, update-status.json with its exit code. The
// server writes update-status.json first, with the versions, so a restart reads how it went:
// - Linux under systemd (INVOCATION_ID, set for a unit's processes): a transient unit of its own (systemd-run
//   --user), outside Cubex's cgroup, which stopping Cubex's unit ends whole. With no user manager to ask (a Cubex
//   started from another service's shell, such as a CI runner's), it starts detached instead;
// - macOS (a launchd login item, which stops Cubex's process group) and a plain background process: detached, in
//   a session of its own;
// - Windows: the script starts itself as a one-time scheduled task, or (no tasks) from a launcher that exits at
//   once, so `cubex stop`'s tree kill (taskkill /t) can't reach it.
// Only an install the installer made, following releases (not pinned to a ref), updates this way. A Docker build
// and a source checkout get the commands to run: giving the app control of Docker would let anyone signed in run
// anything on the host.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { db } from './db';
import { compareVersions, installFolder, parseTag, runningVersion } from './cubex-version';

export type UpdateHow = 'button' | 'pinned' | 'docker' | 'source';
export type Starter = 'systemd' | 'detached' | 'windows';

// An update started from Settings: running, or how it ended (code: the update's exit code; null when the updater
// stopped without saying, a restart of the computer midway). log: the update's last lines.
export interface UpdateRun {
  state: 'running' | 'done' | 'failed';
  from: string;
  to: string;
  started_at: string | null;
  ended_at: string | null;
  code: number | null;
  log: string;
}

// The lock a start takes before its updater writes its own pid there: given up after this long without one.
const STARTING_MS = 2 * 60_000;
const LOG_LINES = 15;
const LOG_CHARS = 2_000;
const VERSION = /^v\d{1,9}\.\d{1,9}\.\d{1,9}$/;

const file = (home: string, name: string) => path.join(home, name);
const read = (p: string) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// How this install updates: the button, or what to run instead.
export function updateHow(): UpdateHow {
  if (installFolder() === null) return fs.existsSync('/.dockerenv') ? 'docker' : 'source';
  return runningVersion().pinned ? 'pinned' : 'button';
}

// Pure: where the updater starts, from the platform and the server's environment.
export function starterFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Starter {
  if (platform === 'win32') return 'windows';
  return platform === 'linux' && env.INVOCATION_ID ? 'systemd' : 'detached';
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

// Pure: whether a lock's text still holds: an updater's live pid, or a start begun under STARTING_MS ago.
export function lockHeld(text: string | null, now: number, isAlive: (pid: number) => boolean = alive): boolean {
  if (text === null) return false;
  const t = text.trim();
  if (/^\d+$/.test(t)) return isAlive(Number(t));
  const m = /^starting (\S+)$/.exec(t);
  return !!m && now - Date.parse(m[1]) < STARTING_MS;
}

// The update's last lines, its terminal colors dropped.
function logTail(home: string): string {
  const text = (read(file(home, 'update.log')) ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  return text.split(/\r?\n/).filter(l => l.trim()).slice(-LOG_LINES).join('\n').slice(-LOG_CHARS);
}

// The last update started from Settings, or null.
export function updateRun(now = Date.now()): UpdateRun | null {
  const home = installFolder();
  if (home === null) return null;
  let s: Record<string, unknown>;
  try { s = JSON.parse((read(file(home, 'update-status.json')) ?? '').replace(/^﻿/, '')); } catch { return null; }
  const text = (k: string) => (typeof s[k] === 'string' ? s[k] as string : null);
  const from = text('from'), to = text('to');
  if (!from || !to) return null;
  const code = typeof s.code === 'number' ? s.code : null;
  const ended = code !== null || !lockHeld(read(file(home, 'update.lock')), now);
  return {
    state: !ended ? 'running' : code === 0 ? 'done' : 'failed',
    from, to, started_at: text('started_at'), ended_at: text('ended_at'), code, log: logTail(home),
  };
}

// Runs that would be cut short: their calls in flight would be paid for again when they resume after the update.
// A paused run picks up after it as it is.
function runsGoing(): number {
  return db.prepare(`SELECT (SELECT COUNT(*) FROM ai_runs WHERE status IN ('pending', 'running'))
    + (SELECT COUNT(*) FROM http_runs WHERE status IN ('pending', 'running'))`).pluck().get() as number;
}

export type StartFail = { fail: 'how' | 'current' | 'running' | 'runs'; message: string };
type Start = (starter: Starter, home: string, script: string, from: string, to: string) => void;
let startForTests: Start | null = null;
// Tests only: record the start instead of running an update.
export function setUpdateStartForTests(start: Start | null): void { startForTests = start; }

// Starts the update to `latest` (the release the check found), or says why not.
export function startUpdate(latest: string | null): { ok: UpdateRun } | StartFail {
  const how = updateHow();
  if (how !== 'button') return { fail: 'how', message: HOW_WORDS[how] };
  const home = installFolder()!;
  const from = runningVersion().version;
  const a = latest ? parseTag(latest) : null, b = from ? parseTag(from) : null;
  if (!latest || !VERSION.test(latest) || !from || !a || !b || compareVersions(a, b) <= 0) {
    return { fail: 'current', message: 'Cubex is on the latest release it knows of. Check for a new one first.' };
  }
  if (updateRun()?.state === 'running') return { fail: 'running', message: 'An update is already running.' };
  const going = runsGoing();
  if (going > 0) {
    return { fail: 'runs', message: `${going === 1 ? 'A run is' : `${going} runs are`} going. The update stops `
      + 'Cubex, so its calls in flight would be paid for again: wait for the runs to finish, or pause them, first.' };
  }
  const lock = file(home, 'update.lock');
  const now = new Date();
  try {
    if (fs.existsSync(lock) && !lockHeld(read(lock), now.getTime())) fs.rmSync(lock, { force: true });
    fs.writeFileSync(lock, `starting ${now.toISOString()}\n`, { flag: 'wx' });
  } catch {
    return { fail: 'running', message: 'An update is already running.' };
  }
  try {
    const name = process.platform === 'win32' ? 'cubex-update-run.ps1' : 'cubex-update-run.sh';
    const script = file(home, name);
    fs.copyFileSync(file(home, path.join('app', 'bin', name)), script);
    fs.rmSync(file(home, 'update.log'), { force: true });
    fs.writeFileSync(file(home, 'update-status.json'),
      `${JSON.stringify({ from, to: latest, started_at: now.toISOString() })}\n`);
    (startForTests ?? start)(starterFor(process.platform, process.env), home, script, from, latest);
  } catch (error) {
    fs.rmSync(lock, { force: true });
    throw error;
  }
  return { ok: updateRun()! };
}

const HOW_WORDS: Record<Exclude<UpdateHow, 'button'>, string> = {
  pinned: 'This install stays on the version it was installed with. Run cubex update --ref <version> to move it.',
  docker: 'This Cubex runs in Docker: pull the new image and start it again (docker compose pull, then up -d).',
  source: 'This Cubex runs from a source checkout: git pull, npm ci and npm run build, then start it again.',
};

function start(starter: Starter, home: string, script: string, from: string, to: string): void {
  const env = { ...process.env, CUBEX_HOME: home };
  if (starter === 'systemd') {
    const out = spawnSync('systemd-run', ['--user', '--collect', '--quiet', `--unit=cubex-update-${Date.now()}`,
      `--setenv=CUBEX_HOME=${home}`, `--working-directory=${home}`, '/bin/sh', script, home, from, to],
    { env, encoding: 'utf8', timeout: 30_000 });
    if (out.status === 0) return;
    console.warn(`systemd-run couldn't start the update (${(out.stderr || out.error?.message || '').trim()}); `
      + 'starting it detached.');
  }
  if (starter === 'windows') {
    const out = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Start',
      '-CubexHome', home, '-From', from, '-To', to], { env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    const why = (out.stderr || out.error?.message || '').trim();
    if (out.status !== 0) throw new Error(`Starting the update failed: ${why}`);
  } else {
    spawn('/bin/sh', [script, home, from, to], { cwd: home, env, detached: true, stdio: 'ignore' }).unref();
  }
}
