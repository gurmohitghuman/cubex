// The WAL checkpoint worker (lib/wal-checkpointer.ts). A bulk writer commits
// with SQLite's own checkpoint off and leaves copying the WAL back into the
// database file to that worker's thread. Sizes are in WAL frames: one page each
// (4 KB, SQLite's default; lib/db.ts keeps it). The writer reads the WAL's size
// after its transactions (frames in it, frames already copied).

// Once this many frames wait in the WAL uncopied, the writer asks the worker for
// a checkpoint and goes on writing (on Windows it asks only at the pause, below,
// lib/wal-checkpointer.ts). About 4 MB, SQLite's own default mark. Every
// checkpoint ends in a disk sync whatever its size (about 50 ms each on the
// Windows CI runner), so about 20 transform pages (about 50 frames each) share
// one instead of each paying its own: 1,201 of them took a 300,000-row pass to
// 62 s there.
export const WAL_CHECKPOINT_FRAMES = 1000;

// Once the WAL holds this many frames in all, copied or not, the writer waits
// between its transactions (never holding the thread) until the worker has
// copied every one: only then does SQLite write the WAL from its start again, so
// the file stays about this size (6 MB) however much the writer writes. Kept
// under wal_autocheckpoint (2,000, lib/db.ts): a commit that leaves the WAL at
// that mark runs SQLite's own checkpoint inside it, on the API thread for an
// autosave or a webhook; the room above is for the writer's last transaction and
// others' commits. A worker that falls behind (a slow disk) is waited for here.
export const WAL_PAUSE_FRAMES = 1500;

// A wait whose checkpoint copied nothing more (another checkpoint held the lock,
// or a reader still reads older frames) tries again this much later, until the
// writer's own deadline.
export const WAL_PAUSE_RETRY_MS = 25;

// On Windows a write waiting for a running checkpoint's answer before it begins (lib/wal-turn.ts) waits this long
// at most, so a worker that never answers can't hold it forever: it then goes on as if the checkpoint weren't
// running, and never waits for that one again. On the Windows CI runner's throttled disk one checkpoint took over
// 30 s (a wait that had this limit gave up on it), and another 24 s.
export const WAL_CHECKPOINT_WAIT_MS = 30_000;

// SQLite's own checkpoint (wal_autocheckpoint, lib/db.ts): it runs inside the commit that leaves the WAL at this
// many frames or more, on that connection's thread. Once the server's WAL watch runs (lib/wal-watch.ts), it asks
// the checkpoint worker at this many uncopied frames instead, and SQLite's own waits for the bulk writers' room on
// every connection, a backstop: no commit copies the WAL back while the worker does.
export const DB_AUTO_CHECKPOINT_FRAMES = 2000;
// How often the WAL watch reads the WAL's size (SQLite's NOOP checkpoint: shared memory, no lock, no I/O). Light
// writes (autosaves, webhooks, a run's results) add tens of frames a second, so it asks well before the room.
export const WAL_WATCH_MS = 500;
// Set by the WAL watch to the database's path (lib/wal-watch.ts): a connection opened in a thread or process the
// server starts after it (a run's job, the lookup worker) leaves its checkpoints to the watch (lib/db.ts).
export const WAL_WATCHED_ENV = 'CUBEX_WAL_WATCHED';
// journal_size_limit (lib/db.ts): the WAL file is cut back to this size when it starts over.
export const DB_WAL_SIZE_LIMIT = 64 * 1024 * 1024;
// Sizing the WAL file at start (lib/wal-file.ts): skipped unless the disk has this much free beyond what it
// writes, so a nearly full disk isn't filled with zeros.
export const WAL_FILE_FREE_MARGIN = 256 * 1024 * 1024;

// Background bulk writers (lib/bulk-slices.ts: an undo, moves in and out of the trash, emptying it, a clear,
// dedupe): as WAL_CHECKPOINT_FRAMES and WAL_PAUSE_FRAMES, much higher. On a slow disk such a job's whole time is
// its number of checkpoints, each about three disk syncs on the worker (two to copy the WAL back, one to start it
// over), whatever its size; one slice can write over 2,000 frames (500 undone rows with three formulas reading
// them), so at the transform's bounds the writer waited for a checkpoint after every slice. Measured on Linux,
// undoing 200,000 rows with three formulas, every disk sync 300 ms slower: 362 s at 1,000 / 1,500, 96 s at
// 5,000 / 10,000, 82 s at these. The WAL then holds up to the pause and one slice: about 14,000 frames, 58 MB,
// under journal_size_limit (64 MB, lib/db.ts), past which every checkpoint would cut the file back.
export const WAL_BULK_CHECKPOINT_FRAMES = 6000;
export const WAL_BULK_PAUSE_FRAMES = 12000;
// A slice's frames grow with its rows' size: dropping 5,000 undo journal rows of about 1,000 bytes each wrote 5,730,
// and the pause plus one such slice took the WAL to 67 MB. So a bulk writer pauses sooner when its biggest slice
// so far would take the WAL past this share of journal_size_limit (lib/bulk-slices.ts). The rest (about 1,600
// frames at 64 MB) is for other writers' commits while the worker copies the WAL back: their own checkpoint copies
// nothing then, so a slow copy lets them take the WAL past journal_size_limit.
export const WAL_BULK_ROOM_SHARE = 0.9;
// The job queue's database (lib/jobs-db.ts, lib/job-inserts.ts): at start, switching it to WAL waits this long at
// most for another process holding it, trying again this often; at shutdown, the inserts already asked of its
// worker get this long to land (a run whose insert didn't is still pending, and the next start queues it again).
export const JOBS_DB_SWITCH_WAIT_MS = 2_000;
export const JOBS_DB_SWITCH_RETRY_MS = 50;
export const JOB_INSERTS_DRAIN_MS = 5_000;
