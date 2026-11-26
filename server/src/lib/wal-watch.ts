// The checkpoint worker as the only checkpointer. SQLite's own checkpoint runs inside the commit that takes the WAL
// to wal_autocheckpoint, on that connection's thread: an autosave, a webhook or a cell edit on the server's thread,
// and on a run's job thread or the lookup worker's, where during a bulk job one commit could copy back about 14,000
// frames. Once the watch runs (the server starts it at boot, a bulk writer if nothing has), every WAL_WATCH_MS it
// reads the WAL's size on this connection (SQLite's NOOP checkpoint: shared memory, no lock, no I/O) and, once the
// WAL holds DB_AUTO_CHECKPOINT_FRAMES, asks the worker (lib/wal-checkpointer.ts), which copies back what every
// connection wrote, in any thread or process, and starts the WAL over itself if it then finds every frame copied.
// Under steady writes a commit often lands during that checkpoint, leaving a few frames uncopied and the WAL not
// started over: the watch asks again at its next look while the WAL is still past the mark, so the worker gets a
// chance every WAL_WATCH_MS, as a commit past the mark did when SQLite's own checkpoint ran in it. A WAL just as the
// last answer left it (a reader holding it: the same ask would answer the same) isn't asked about again.
// SQLite's own checkpoint then waits for the bulk writers' room on every connection (lib/wal-room.ts): this one now,
// and those opened after in the threads and the processes the server starts, which find the mark the watch leaves in
// the environment (lib/db.ts) once the worker has answered ready (walWatchReady: the job queue waits for it before it
// forks its process, queue.ts), so a worker that can't start never leaves threads at the room. It stays on as a
// backstop: a watch that can't keep up (the event loop held) leaves the WAL bounded by the room, as while a bulk job
// runs; a worker stuck inside a checkpoint holds SQLite's checkpoint lock, so nothing bounds the WAL until it
// answers (as before this watch). While a bulk writer runs the
// watch asks nothing: the writer asks at its own marks before each slice (lib/bulk-slices.ts), and asking at 2,000
// would multiply its checkpoints, each a few disk syncs. With no worker (it couldn't start, or stopped twice) the
// watch asks nothing either, since its checkpoints would copy every thread's frames on this one's event loop: this
// connection's own checkpoint is back at DB_AUTO_CHECKPOINT_FRAMES, as before, and the mark leaves the environment,
// so threads and processes started from then on checkpoint their own.
import { isMainThread } from 'worker_threads';
import { db } from './db';
import { DB_PATH } from './db-path';
import { DB_AUTO_CHECKPOINT_FRAMES, WAL_WATCH_MS, WAL_WATCHED_ENV } from './constants';
import {
  checkpointInBackground, checkpointsOnWorker, startWalCheckpointer, walState, type WalState,
} from './wal-checkpointer';
import { walRoomFrames } from './wal-room';

let timer: NodeJS.Timeout | null = null;
// Set by stopWalWatch: a bulk writer starting after it (at shutdown) doesn't start the watch again.
let stopped = false;
// Whether the watch ever ran, and whether the worker answered ready (the mark goes in the environment only then).
let started = false;
let confirmed = false;
let ready: Promise<void> | null = null;
let bulkWriters = 0;
// What this connection's own checkpoint was last set to by the watch (0: not yet).
let ownMark = 0;
// The WAL as the last checkpoint the watch asked for left it.
let leftAs: WalState | null = null;

// This connection's own checkpoint: the room while checkpoints go to the worker, else DB_AUTO_CHECKPOINT_FRAMES.
// Found changed since the watch set it (a commit with it off never leaves it so: lib/slices.ts), it is logged and
// set right.
function setOwnMark(onWorker: boolean): void {
  const mark = onWorker ? walRoomFrames(db) : DB_AUTO_CHECKPOINT_FRAMES;
  const now = db.pragma('wal_autocheckpoint', { simple: true }) as number;
  if (now === mark) { ownMark = mark; return; }
  if (ownMark !== 0 && now !== ownMark) {
    console.error(`SQLite's own WAL checkpoint was at ${now} with the WAL watch running; set back to ${mark}.`);
  }
  db.pragma(`wal_autocheckpoint = ${mark}`);
  ownMark = mark;
}

// One look at the WAL (above).
export function watchWal(): void {
  try {
    const onWorker = checkpointsOnWorker();
    setOwnMark(onWorker);
    if (!onWorker) { delete process.env[WAL_WATCHED_ENV]; return; }
    if (confirmed) process.env[WAL_WATCHED_ENV] = DB_PATH;
    if (bulkWriters > 0) return;
    const s = walState();
    if (!s || s.log < DB_AUTO_CHECKPOINT_FRAMES) return;
    if (leftAs && leftAs.log === s.log && leftAs.checkpointed === s.checkpointed) return;
    void checkpointInBackground().then(() => { leftAs = walState(); }, () => { leftAs = null; });
  } catch (err) {
    console.error('Reading the WAL\'s size failed:', err);
  }
}

// Starts the watch for this process, once: on the main thread only (a worker thread's writers are watched by the
// server's). Never keeps the process running. The worker is started now; the mark goes in the environment once it
// answers ready.
export function startWalWatch(): void {
  if (timer || stopped || !isMainThread) return;
  started = true;
  setOwnMark(checkpointsOnWorker());
  ready = startWalCheckpointer().then(up => {
    confirmed = up;
    if (up && !stopped) process.env[WAL_WATCHED_ENV] = DB_PATH;
    else if (!stopped) setOwnMark(false);
  }, () => { /* couldn't start: logged there, and checked again at each look */ });
  timer = setInterval(watchWal, WAL_WATCH_MS);
  timer.unref();
}

// Once the watch knows whether the worker is up (the mark in the environment or not): what starts a thread or a
// process that must inherit it waits for this (queue.ts).
export const walWatchReady = (): Promise<void> => ready ?? Promise.resolve();

// At shutdown, and in tests: no more looks, and SQLite's own checkpoint back at DB_AUTO_CHECKPOINT_FRAMES here, once
// no bulk writer runs (one still writing during the stop's grace keeps its room until it ends: bulkWriterRunning).
// Threads and processes started after it check for themselves again.
export function stopWalWatch(): void {
  stopped = true;
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  ownMark = 0;
  leftAs = null;
  confirmed = false;
  delete process.env[WAL_WATCHED_ENV];
  if (bulkWriters === 0) db.pragma(`wal_autocheckpoint = ${DB_AUTO_CHECKPOINT_FRAMES}`);
}

// A bulk writer starting (lib/bulk-slices.ts): the watch asks nothing until the answer is called (in a finally).
// Called twice, the second is logged and ignored.
export function bulkWriterRunning(): () => void {
  bulkWriters++;
  let ended = false;
  return () => {
    if (ended) {
      console.error('A bulk writer ended twice; the second time is ignored.');
      return;
    }
    ended = true;
    bulkWriters = Math.max(0, bulkWriters - 1);
    if (stopped && started && bulkWriters === 0) db.pragma(`wal_autocheckpoint = ${DB_AUTO_CHECKPOINT_FRAMES}`);
  };
}
// Tests only: how many run now.
export const bulkWritersRunning = (): number => bulkWriters;
