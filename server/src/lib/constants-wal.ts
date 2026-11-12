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
