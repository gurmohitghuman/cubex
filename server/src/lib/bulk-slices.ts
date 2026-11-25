// Bulk writers (each caller of asBulkWriter, below: undo, the trash, a run's clear, sorts, imports, dedupe, formulas,
// answer fields, auto-run, list results, hiring summaries, sheet copies, run rewrites, pruning) write in slices whose
// WAL is copied back on the checkpoint worker's thread, as transform_column's pages are. A checkpoint ends in disk
// syncs: run here after every slice, on a slow disk they held the server up to 670 ms each (undoing 200,000 rows with
// three formulas reading them, every sync 300 ms slower).
// - Before each slice, walRoom with the bulk bounds (lib/constants-wal.ts): past WAL_BULK_CHECKPOINT_FRAMES
//   uncopied it asks the worker and goes on (not on Windows, where a slice never overlaps a checkpoint: it asks only
//   at the pause, and waits for one running, lib/wal-turn.ts); at WAL_BULK_PAUSE_FRAMES in the WAL it awaits, the
//   event loop free, until the worker has copied every frame and started the WAL over. A reader holding the
//   frames (a backup): the job goes on, the WAL growing meanwhile as it would with no worker, and asks again
//   WAL_PAUSE_RETRY_MS later at the soonest.
// - The pause comes sooner when one more slice as big as the job's biggest so far would take the WAL past
//   WAL_BULK_ROOM_SHARE of journal_size_limit (big rows make big slices); before the first, at the ask mark.
// - Each slice is one transaction, `step` inside it (its own run flat in it: oneTransaction, lib/slices.ts; a
//   nested one would be a savepoint, slow), committed with SQLite's own checkpoint off and taken in turn with the
//   worker's write that starts the WAL over (lib/wal-turn.ts): it never starts the WAL over itself, which syncs the
//   WAL's new header inside its commit. One slice a turn of the event loop, across writers (lib/slice-turn.ts).
// - After the last slice, what's left is copied back on the worker and the WAL started over before the job goes
//   on (startedOver, below), so the next commit on this connection doesn't copy it back or start the WAL over;
//   unless the job wrote few frames and the WAL holds fewer than SQLite's own checkpoint waits for (a short job).
// - While any runs, SQLite's own checkpoint on the API connection waits for the job's room (holdAutoCheckpoint:
//   WAL_BULK_ROOM_SHARE of journal_size_limit, about 14,600 frames at 64 MB) instead of DB_AUTO_CHECKPOINT_FRAMES.
//   The WAL holds up to about 14,000 frames during a job, and at 2,000 any other commit there (an autosave, the
//   job's own) would copy them back inside it. The job alone stays under the room (its pause is fitted to it). A
//   writer outside the runner (API row writes) past it copies the WAL back in its own commit, as with no job (with
//   SQLite's own checkpoint off the WAL grew while both went on), but copies nothing while the worker copies: the
//   WAL holds the room and what such writers commit in one copy, on a slow disk past journal_size_limit.
// - No deadline by default: a background job waits for the worker as long as it takes. A writer with one passes
//   `until`; past it, walRoom no longer waits and the slice is still written, in turn.
// - With no worker (it couldn't start, or stopped twice) checkpoints run on this thread, as before:
//   SQLite's own checkpoint goes back on and the bounds are the transform walk's, so none copies more back.
//   Off the main thread (the lookup worker loads some of these writers) slices are checkpointed there.
import { isMainThread } from 'worker_threads';
import { db } from './db';
import {
  DB_AUTO_CHECKPOINT_FRAMES, DB_WAL_SIZE_LIMIT, WAL_BULK_CHECKPOINT_FRAMES, WAL_BULK_PAUSE_FRAMES, WAL_BULK_ROOM_SHARE,
  WAL_CHECKPOINT_FRAMES, WAL_PAUSE_FRAMES, WAL_PAUSE_RETRY_MS,
} from './constants';
import { withoutAutoCheckpoint, yieldToRequests } from './slices';
import {
  byDeadline, checkpointInBackground, checkpointsOnWorker, walRoom, walState, type WalBounds,
} from './wal-checkpointer';
import { inWalTurn, walTurnCheck } from './wal-turn';
import { takeSliceTurn } from './slice-turn';

const BULK: WalBounds = { ask: WAL_BULK_CHECKPOINT_FRAMES, pause: WAL_BULK_PAUSE_FRAMES };
const ON_THIS_THREAD: WalBounds = { ask: WAL_CHECKPOINT_FRAMES, pause: WAL_PAUSE_FRAMES };

let holders = 0;
const auto = () => db.pragma('wal_autocheckpoint', { simple: true }) as number;
const setAuto = (frames: number) => { db.pragma(`wal_autocheckpoint = ${frames}`); };

// SQLite's own checkpoint on the API connection held at the job's room (walRoomFrames) until the answer is called
// (in a finally): the first holder raises it, the last puts it back. Found changed with no holder, or released once
// too often, it is logged and set right.
export function holdAutoCheckpoint(): () => void {
  if (holders === 0 && auto() !== DB_AUTO_CHECKPOINT_FRAMES) {
    console.error(`SQLite's own WAL checkpoint was at ${auto()} with no bulk writer running; set back to `
      + `${DB_AUTO_CHECKPOINT_FRAMES}.`);
    setAuto(DB_AUTO_CHECKPOINT_FRAMES);
  }
  holders++;
  setAuto(walRoomFrames());
  let released = false;
  return () => {
    if (released) {
      console.error('A bulk writer let go of SQLite\'s own WAL checkpoint twice; the second time is ignored.');
      return;
    }
    released = true;
    if (--holders < 0) {
      console.error('Bulk writers holding SQLite\'s own WAL checkpoint fell below zero; counted as none.');
      holders = 0;
    }
    if (holders === 0) setAuto(DB_AUTO_CHECKPOINT_FRAMES);
  };
}
// Tests only: how many hold it now.
export const autoCheckpointHolders = (): number => holders;

// The frames the WAL may reach during a job: WAL_BULK_ROOM_SHARE of journal_size_limit (none set: lib/db.ts's).
function walRoomFrames(): number {
  const limit = db.pragma('journal_size_limit', { simple: true }) as number;
  const page = db.pragma('page_size', { simple: true }) as number;
  return Math.floor((WAL_BULK_ROOM_SHARE * (limit > 0 ? limit : DB_WAL_SIZE_LIMIT)) / (page + 24));
}
// `b`, its pause brought forward so a slice of `biggest` frames (0: none written yet) still fits in `room`.
function fitted(b: WalBounds, room: number, biggest: number): WalBounds {
  const pause = Math.max(0, Math.min(b.pause, biggest === 0 ? b.ask : room - biggest));
  return { ask: Math.min(b.ask, pause), pause };
}

export interface BulkWriter {
  // One slice: `step` in one transaction, after room in the WAL, in turn. Answers what `step` does.
  slice<T>(step: () => T): Promise<T>;
  // The WAL frames (pages) the last slice wrote: 0 before the first, or with none read (off the main thread).
  lastFrames(): number;
}

// Runs `work` as a bulk writer (above), its slices made through the BulkWriter it is given.
export async function asBulkWriter<T>(work: (w: BulkWriter) => Promise<T>, until = Infinity): Promise<T> {
  if (!isMainThread) return work(onThisThread);
  let release: (() => void) | null = checkpointsOnWorker() ? holdAutoCheckpoint() : null;
  let askAfter = 0;
  let wrote = false;
  const room = walRoomFrames();
  let biggest = 0;
  let written = 0;
  let last = 0;
  const writer: BulkWriter = {
    lastFrames: () => last,
    async slice<T>(step: () => T): Promise<T> {
      const onWorker = checkpointsOnWorker();
      // The worker couldn't start, or stopped twice: checkpoints run here from now on.
      if (!onWorker && release) { release(); release = null; }
      const bounds = fitted(onWorker ? BULK : ON_THIS_THREAD, room, biggest);
      if (Date.now() >= askAfter && await walRoom(until, bounds) === 'held') {
        askAfter = Date.now() + WAL_PAUSE_RETRY_MS;
      }
      // A turn of its own. After a wait, this goes on in the turn that read the worker's answer, and a yield
      // after the slice would come back in that same turn: two slices back to back, nothing served between
      // (about 100 ms at once undoing 200,000 rows with three formulas).
      await yieldToRequests();
      // One slice a turn of the event loop, whichever writer's (lib/slice-turn.ts).
      const done = await takeSliceTurn();
      const tx = db.transaction(() => { walTurnCheck(); return step(); });
      let out: T;
      try {
        // Always written (`anyway`): never 'late'. In turn, so the WAL isn't started over between the two reads.
        out = await inWalTurn(() => {
          const before = walState();
          const r = withoutAutoCheckpoint(() => tx.immediate());
          const after = walState();
          last = before && after ? Math.max(0, after.log - before.log) : 0;
          biggest = Math.max(biggest, last);
          written += last;
          return r;
        }, until, true) as T;
      } finally {
        done();
      }
      wrote = true;
      return out;
    },
  };
  try {
    return await work(writer);
  } finally {
    try {
      if (wrote) await startedOver(until, written);
    } finally {
      release?.();
    }
  }
}

// After the last slice, before SQLite's own checkpoint comes back on: the WAL copied back on the worker and
// started over after the job's last frame. Else the next commit on this connection copies the rest back inside it,
// or starts the WAL over and syncs its new header there. A checkpoint already running when the job ended never saw
// its last frames, and a reader can hold them a moment: tried again, WAL_PAUSE_RETRY_MS later, three tries at most.
// With no worker, one checkpoint here, as before. A short job (a run started on 10 rows: under SHORT_JOB_FRAMES
// written) that leaves fewer frames than SQLite's own checkpoint waits for, none of them copied yet, doesn't wait:
// the next commit here copies none back and starts nothing over, as with no runner, and a worker's checkpoint would
// hold the job up for nothing. A big job that ends just under the mark (the WAL started over part way) still waits:
// else the next small commit takes the WAL past it and copies the job's frames back inside it.
const SHORT_JOB_FRAMES = DB_AUTO_CHECKPOINT_FRAMES / 2;
async function startedOver(until: number, written: number): Promise<void> {
  const end = walState();
  if (!end || end.log === 0) return;
  if (written < SHORT_JOB_FRAMES && end.log < DB_AUTO_CHECKPOINT_FRAMES && end.checkpointed < end.log) return;
  if (!checkpointsOnWorker()) {
    if (end.checkpointed < end.log) await byDeadline(checkpointInBackground(), until);
    return;
  }
  for (let tries = 0; tries < 3; tries++) {
    if (tries > 0 && await byDeadline(new Promise(r => setTimeout(r, WAL_PAUSE_RETRY_MS)), until) === 'late') return;
    const now = walState();
    // Started over since: every frame was copied first.
    if (!now || now.log < end.log) return;
    const r = await byDeadline(checkpointInBackground(), until);
    if (r === 'late' || r === null) return;
    if (r.log >= end.log && r.startOver === 'done') return;
  }
}

// Off the main thread: each slice with SQLite's own checkpoint off, then a checkpoint on this connection.
const onThisThread: BulkWriter = {
  lastFrames: () => 0,
  async slice<T>(step: () => T): Promise<T> {
    const out = withoutAutoCheckpoint(() => db.transaction(step).immediate());
    await yieldToRequests();
    db.pragma('wal_checkpoint(PASSIVE)');
    return out;
  },
};

// `step` slice after slice while it answers true, the server answering requests between slices.
export async function runInCheckpointedSlices(step: () => boolean): Promise<void> {
  await asBulkWriter(async w => { while (await w.slice(step)) await yieldToRequests(); });
}
