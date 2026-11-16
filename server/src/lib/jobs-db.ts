// The job queue's own database (jobs.db) in WAL mode, set before the queue opens it (queue.ts startQueue). In the
// queue library's default mode (a rollback journal) each commit made 4 disk syncs, and a reader waited while
// another connection committed: with every sync 300 ms slower, queuing a run held the server 1.2 s, and
// /api/health's read of jobs.db waited up to 2.4 s on the server's thread while the queue's process claimed,
// started or finished a job.
// - The mode is stored in the file, so every connection the queue opens uses it: the server's, the queue's own
//   process and its job threads (their settings reach that process as JSON, which can't carry a setup of their
//   connections). Opened on a WAL file, each gets synchronous=NORMAL (the SQLite driver's default for WAL): a
//   commit makes no sync, only a checkpoint does. A reader never waits for a writer.
// - After a power cut or an OS crash (not a crashed process), the queue's last changes can roll back. No run is
//   lost: every start queues each pending or running run again from cubex.db (lib/orphan-runs.ts), which works
//   the same way, and a job that comes back stops itself if its run is finished or its generation moved.
// - Switching keeps every row; SQLite first rolls back a transaction a crash left unfinished, as any open does.
//   While another process holds the file, it tries again every JOBS_DB_SWITCH_RETRY_MS, the server's thread free
//   meanwhile (SQLite gives up at once when that process is writing); past JOBS_DB_SWITCH_WAIT_MS the queue starts
//   in its old mode (logged) and the next start tries again. On a file already in WAL it writes nothing.
import Database from 'better-sqlite3';
import { JOBS_DB_SWITCH_RETRY_MS, JOBS_DB_SWITCH_WAIT_MS } from './constants';

const busy = (err: unknown): boolean => (err as { code?: string })?.code?.startsWith('SQLITE_BUSY') === true;

// The journal mode jobs.db is in afterwards ('wal', or what it stayed in), or null if it couldn't be switched.
export async function jobsDbInWal(file: string): Promise<string | null> {
  let jobs: Database.Database | null = null;
  const until = Date.now() + JOBS_DB_SWITCH_WAIT_MS;
  try {
    jobs = new Database(file, { timeout: 0 });
    for (;;) {
      try {
        const mode = String(jobs.pragma('journal_mode = WAL', { simple: true }));
        if (mode !== 'wal') console.error(`jobs.db stayed in ${mode} mode; the next start tries WAL again.`);
        return mode;
      } catch (err) {
        if (!busy(err) || Date.now() >= until) throw err;
        await new Promise(r => setTimeout(r, JOBS_DB_SWITCH_RETRY_MS));
      }
    }
  } catch (err) {
    console.error('Switching jobs.db to WAL mode failed; the queue starts in its old mode, and the next start '
      + 'tries again:', err);
    return null;
  } finally {
    try { jobs?.close(); } catch { /* the queue opens it again */ }
  }
}
