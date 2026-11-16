// The job queue's inserts (lib/job-inserts.ts), on this worker thread with a connection of its own to jobs.db:
// the queue library's own insert of a job its builder made on the server's thread, one at a time in the order
// asked. A sync jobs.db makes inside an insert (a checkpoint, or the WAL started over after one) is made here.
// 'close' answers once every insert asked before it has, then closes the connection and ends the thread.
import { parentPort, workerData } from 'worker_threads';
import SqliteBackend from '@sidequest/sqlite-backend';
import type { NewJobData } from 'sidequest';

export type InsertAsk = { id: number; job: NewJobData; delayMs: number } | 'close';
export type InsertReply = { id: number; error?: string } | 'closed';

const { file } = workerData as { file: string };
const backend = new SqliteBackend(file);
let chain: Promise<void> = Promise.resolve();

async function insert(ask: Exclude<InsertAsk, 'close'>): Promise<InsertReply> {
  try {
    // Tests only: hold the insert this long, as a slow disk would.
    if (ask.delayMs > 0) await new Promise(r => setTimeout(r, ask.delayMs));
    await backend.createNewJob(ask.job);
    return { id: ask.id };
  } catch (err) {
    return { id: ask.id, error: err instanceof Error ? err.message : String(err) };
  }
}

parentPort!.on('message', (ask: InsertAsk) => {
  chain = chain.then(async () => {
    if (ask !== 'close') { parentPort!.postMessage(await insert(ask)); return; }
    try { await backend.close(); } finally {
      parentPort!.postMessage('closed');
      parentPort!.close();
    }
  });
});
