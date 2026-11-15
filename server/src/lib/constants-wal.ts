// The WAL checkpoint worker (lib/wal-checkpointer.ts). A bulk writer commits
// with SQLite's own checkpoint off and leaves copying the WAL back into the
// database file to that worker's thread. Sizes are in WAL frames: one page each
// (4 KB, SQLite's default; lib/db.ts keeps it). The writer reads the WAL's size
// after its transactions (frames in it, frames already copied).

// Once this many frames wait in the WAL uncopied, the writer asks the worker for
// a checkpoint and goes on writing. About 4 MB, SQLite's own default mark. Every
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

// SQLite's own checkpoint (wal_autocheckpoint, lib/db.ts): it runs inside the commit that leaves the WAL at this
// many frames or more, on that connection's thread. On the API connection it is off while a background bulk
// writer runs (lib/bulk-slices.ts), and back at this value once the last one ends.
export const DB_AUTO_CHECKPOINT_FRAMES = 2000;

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
// so far would take the WAL past this share of journal_size_limit (lib/bulk-slices.ts).
export const WAL_BULK_ROOM_SHARE = 0.9;
