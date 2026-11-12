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
// (lib/constants-wal.ts). The WAL's size is read on the API connection with
// SQLite's NOOP checkpoint: it checkpoints nothing, takes no lock and does no
// I/O, it reads the WAL index in shared memory. If the worker can't start, the
// checkpoint runs here, as it did before (logged). Used by transform_column.
import { Worker } from 'worker_threads';
import { extname, join } from 'path';
import { db } from './db';
import { WAL_CHECKPOINT_FRAMES, WAL_PAUSE_FRAMES, WAL_PAUSE_RETRY_MS } from './constants';
import type { CheckpointAsk, CheckpointReply } from './wal-checkpoint-worker';

// Frames in the WAL, and frames of them already copied into the database file.
export interface WalState { log: number; checkpointed: number }

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
let running: Promise<WalState | null> | null = null;
let seq = 0;
let delayMs = 0;
let warned = false;
const waiting = new Map<number, (r: CheckpointReply) => void>();
const zero = () => ({ checkpoints: 0, onThisThread: 0, pauses: 0, pausedMs: 0 });
let stats = zero();

function start(): Promise<Worker | null> {
  return new Promise(resolve => {
    let w: Worker;
    try { w = newWorker(); } catch (err) {
      console.error('The WAL checkpoint worker could not start; checkpoints run on the main thread:', err);
      resolve(null);
      return;
    }
    w.on('message', (m: CheckpointReply | 'ready') => {
      if (m === 'ready') { worker = w; w.unref(); resolve(w); return; }
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
    });
    w.on('error', err => console.error('The WAL checkpoint worker failed:', err));
    w.on('exit', () => {
      if (worker === w) worker = null;
      for (const [id, done] of waiting) done({ id, busy: 1, log: -1, checkpointed: -1, error: 'stopped' });
      waiting.clear();
      resolve(null);
    });
  });
}

async function runOne(): Promise<WalState | null> {
  if (!worker) {
    starting ??= start().finally(() => { starting = null; });
    await starting;
  }
  const w = worker;
  stats.checkpoints++;
  if (!w) {
    if (!warned) console.error('No WAL checkpoint worker: checkpointing on the main thread.');
    warned = true;
    stats.onThisThread++;
    const [r] = db.pragma('wal_checkpoint(PASSIVE)') as CheckpointReply[];
    return r.log >= 0 ? { log: r.log, checkpointed: r.checkpointed } : null;
  }
  const id = ++seq;
  const r = await new Promise<CheckpointReply>(resolve => {
    waiting.set(id, resolve);
    // A pending answer keeps the process alive only while it is awaited.
    w.ref();
    w.postMessage({ id, delayMs } as CheckpointAsk);
  }).finally(() => { if (waiting.size === 0) w.unref(); });
  if (r.error && r.error !== 'stopped') console.error('A WAL checkpoint failed:', r.error);
  return r.log >= 0 ? { log: r.log, checkpointed: r.checkpointed } : null;
}

// A checkpoint on the worker; callers while one runs share it (it copies what
// the WAL held when it started).
export function checkpointInBackground(): Promise<WalState | null> {
  running ??= runOne().catch(err => {
    console.error('A WAL checkpoint failed:', err);
    return null;
  }).finally(() => { running = null; });
  return running;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Between a bulk writer's transactions. `until` (ms since the epoch): the
// writer's own deadline, past which it stops waiting (and stops writing).
export async function walRoom(until: number): Promise<void> {
  const startedAt = Date.now();
  let paused = false;
  try {
    for (let s = walState(); s;) {
      if (s.log - s.checkpointed >= WAL_CHECKPOINT_FRAMES) void checkpointInBackground();
      if (s.log < WAL_PAUSE_FRAMES || s.checkpointed >= s.log || Date.now() >= until) return;
      paused = true;
      await checkpointInBackground();
      const after = walState();
      // No further (another checkpoint held the lock, a reader holds older frames): a moment later.
      if (after && after.log === s.log && after.checkpointed === s.checkpointed) await sleep(WAL_PAUSE_RETRY_MS);
      s = after;
    }
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
// Tests only: the worker's file (one that can't start: checkpoints then run here).
export function setCheckpointWorkerFileForTests(file: string | null): void {
  workerFile = file === null ? () => join(__dirname, `wal-checkpoint-worker${extname(__filename)}`) : () => file;
}
// Checkpoints asked for (and of them run on this thread), waits and their time, since the last read.
export function takeWalCheckpointerStats(): ReturnType<typeof zero> {
  const s = stats;
  stats = zero();
  return s;
}
