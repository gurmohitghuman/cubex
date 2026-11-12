// Over 200 lines: the one checkpoint worker's life (start, fall back, close) and the waits writers make on it,
// read together.
// Checkpoints off the API thread, for bulk writers that commit page after page
// with SQLite's own checkpoint off (withoutAutoCheckpoint, lib/slices.ts): a
// checkpoint ends in a disk sync, and on a slow disk (the Windows CI runner)
// each one held the server about 50 ms, 1,201 of them a 300,000-row pass. Here
// one worker thread for the process (wal-checkpoint-worker.ts), started on first
// use and never keeping Cubex running, copies the WAL back on its own
// connection. Between its transactions a writer calls walRoom: past
// WAL_CHECKPOINT_FRAMES uncopied frames it asks the worker for a checkpoint and
// goes on; at WAL_PAUSE_FRAMES in all it waits (awaiting, never blocking) until
// the worker has copied them, so the WAL starts over and stays bounded
// (lib/constants-wal.ts), unless its deadline comes first or a reader holds the
// frames: the writer then stops there. The WAL's size is read on the API
// connection with SQLite's NOOP checkpoint: it checkpoints nothing, takes no
// lock and does no I/O, it reads the WAL index in shared memory. If the worker
// can't start (a file missing from the install), checkpoints run here, as they
// did before, for as long as the process runs: logged once, never tried again.
// A worker that had started and stops is started once more. Used by
// transform_column.
import { Worker } from 'worker_threads';
import { extname, join } from 'path';
import { db } from './db';
import { WAL_CHECKPOINT_FRAMES, WAL_PAUSE_FRAMES, WAL_PAUSE_RETRY_MS } from './constants';
import type { CheckpointAsk, CheckpointReply } from './wal-checkpoint-worker';

// Frames in the WAL, and frames of them already copied into the database file.
export interface WalState { log: number; checkpointed: number }
// A checkpoint's: `busy` when another checkpoint held the lock, so it couldn't run.
export interface Checkpointed extends WalState { busy: boolean }

// null: not in WAL mode, or the WAL index was being changed just then (SQLite answers -1; rare).
export function walState(): WalState | null {
  const [r] = db.pragma('wal_checkpoint(NOOP)') as Array<{ log: number; checkpointed: number }>;
  return r && r.log >= 0 && r.checkpointed >= 0 ? { log: r.log, checkpointed: r.checkpointed } : null;
}

// The worker's file next to this one: .ts under tsx (it registers tsx itself: a
// worker thread doesn't get the parent's loaders), .js once built.
let workerFile = (): string => join(__dirname, `wal-checkpoint-worker${extname(__filename)}`);
function newWorker(): Worker {
  const file = workerFile();
  if (!file.endsWith('.ts')) return new Worker(file);
  const tsx = require.resolve('tsx/cjs/api');
  return new Worker(`require(${JSON.stringify(tsx)}).register(); require(${JSON.stringify(file)});`, { eval: true });
}

let worker: Worker | null = null;
let starting: Promise<Worker | null> | null = null;
let running: Promise<Checkpointed | null> | null = null;
let seq = 0;
let delayMs = 0;
// Set for the rest of the process once a worker couldn't start, or the one started again stopped too.
let onMainThread = false;
let stops = 0;
const waiting = new Map<number, (r: CheckpointReply) => void>();
const zero = () => ({ starts: 0, checkpoints: 0, onThisThread: 0, pauses: 0, pausedMs: 0 });
let stats = zero();
const fallBack = (why: string, err: unknown) => {
  onMainThread = true;
  console.error(`The WAL checkpoint worker ${why}, so checkpoints run on the main thread until Cubex restarts:`, err);
};

function start(): Promise<Worker | null> {
  stats.starts++;
  return new Promise(resolve => {
    let ready = false;
    let failure: unknown;
    let w: Worker;
    try { w = newWorker(); } catch (err) {
      fallBack('could not start', err);
      resolve(null);
      return;
    }
    w.on('message', (m: CheckpointReply | 'ready') => {
      if (m === 'ready') { ready = true; worker = w; w.unref(); resolve(w); return; }
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
    });
    w.on('error', err => {
      failure = err;
      if (ready) console.error('The WAL checkpoint worker failed:', err);
    });
    w.on('exit', code => {
      const stopped = worker === w;
      if (stopped) worker = null;
      for (const [id, done] of waiting) done({ id, busy: 1, log: -1, checkpointed: -1, error: 'stopped' });
      waiting.clear();
      if (!ready) fallBack('could not start', failure ?? `it exited with code ${code}`);
      else if (stopped && ++stops > 1) fallBack('stopped again', failure ?? `it exited with code ${code}`);
      resolve(null);
    });
  });
}

async function runOne(): Promise<Checkpointed | null> {
  if (!worker && !onMainThread) {
    starting ??= start().finally(() => { starting = null; });
    await starting;
  }
  const w = worker;
  stats.checkpoints++;
  if (!w) {
    stats.onThisThread++;
    const [r] = db.pragma('wal_checkpoint(PASSIVE)') as CheckpointReply[];
    return r.log >= 0 ? { log: r.log, checkpointed: r.checkpointed, busy: r.busy === 1 } : null;
  }
  const id = ++seq;
  const r = await new Promise<CheckpointReply>(resolve => {
    waiting.set(id, resolve);
    // A pending answer keeps the process alive only while it is awaited.
    w.ref();
    w.postMessage({ id, delayMs } as CheckpointAsk);
  }).finally(() => { if (waiting.size === 0) w.unref(); });
  if (r.error && r.error !== 'stopped') console.error('A WAL checkpoint failed:', r.error);
  return r.log >= 0 ? { log: r.log, checkpointed: r.checkpointed, busy: r.busy === 1 } : null;
}

// A checkpoint on the worker; callers while one runs share it (it copies what
// the WAL held when it started).
export function checkpointInBackground(): Promise<Checkpointed | null> {
  running ??= runOne().catch(err => {
    console.error('A WAL checkpoint failed:', err);
    return null;
  }).finally(() => { running = null; });
  return running;
}

// `p`, or 'late' once `until` (ms since the epoch) comes first.
function byDeadline<T>(p: Promise<T>, until: number): Promise<T | 'late'> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>(r => { timer = setTimeout(() => r('late'), Math.max(0, until - Date.now())); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

// Between a bulk writer's transactions: true to go on, false to stop now. `until`
// (ms since the epoch): the writer's own deadline. A wait stops there, even
// while a slow checkpoint still runs, and at once when a checkpoint copied
// nothing with no other checkpoint holding the lock: a reader still reads those
// frames (a backup, a sqlite3 shell), and waiting wouldn't free them.
export async function walRoom(until: number): Promise<boolean> {
  const startedAt = Date.now();
  let paused = false;
  try {
    for (let s = walState(); s;) {
      if (s.log - s.checkpointed >= WAL_CHECKPOINT_FRAMES) void checkpointInBackground();
      if (s.log < WAL_PAUSE_FRAMES || s.checkpointed >= s.log) return true;
      if (Date.now() >= until) return false;
      paused = true;
      const r = await byDeadline(checkpointInBackground(), until);
      if (r === 'late') return false;
      const after = walState();
      if (after && after.log === s.log && after.checkpointed === s.checkpointed) {
        if (r && !r.busy) return false;
        // Another checkpoint held the lock: a moment later.
        await byDeadline(new Promise<void>(res => setTimeout(res, WAL_PAUSE_RETRY_MS)), until);
      }
      s = after;
    }
    return true;
  } finally {
    if (paused) { stats.pauses++; stats.pausedMs += Date.now() - startedAt; }
  }
}

// After a writer's last transaction: what it left uncopied goes back too, on
// the worker, so the next commit (whoever makes it) doesn't copy it.
export function walSettle(): void {
  try {
    const s = walState();
    if (s && s.checkpointed < s.log) void checkpointInBackground();
  } catch (err) {
    console.error('Reading the WAL\'s size failed:', err);
  }
}

// At shutdown, and in tests: the worker closes its connection and ends. A later
// use starts a new one.
export async function closeWalCheckpointer(): Promise<void> {
  await starting;
  await running;
  const w = worker;
  worker = null;
  if (!w) return;
  const exited = new Promise<void>(r => w.once('exit', () => r()));
  w.postMessage('close' as CheckpointAsk);
  const timer = setTimeout(() => void w.terminate(), 2000);
  await exited;
  clearTimeout(timer);
}

// The checkpoint running now, if any, once it ends.
export async function walCheckpointerIdle(): Promise<void> { await running; }

// Tests only: each checkpoint first waits this long on the worker, as on a slow disk.
export function setCheckpointDelayForTests(ms: number): void { delayMs = ms; }
// Tests only: the worker ends as a failing one would (it counts as stopped).
export async function stopCheckpointWorkerForTests(): Promise<void> {
  const w = worker;
  if (!w) return;
  const exited = new Promise<void>(r => w.once('exit', () => r()));
  await w.terminate();
  await exited;
}
// Tests only: the worker's file (one that can't start: checkpoints then run here), forgetting a failed start.
export function setCheckpointWorkerFileForTests(file: string | null): void {
  workerFile = file === null ? () => join(__dirname, `wal-checkpoint-worker${extname(__filename)}`) : () => file;
  onMainThread = false;
  stops = 0;
}
// Workers started, checkpoints asked for (and of them run on this thread), waits and their time, since the
// last read.
export function takeWalCheckpointerStats(): ReturnType<typeof zero> {
  const s = stats;
  stats = zero();
  return s;
}
