// The lookup worker thread (started by services/lookup-host.ts): keeps
// looked-up sheets' keys current on its own database connection (lib/db.ts,
// the same settings), one request at a time: 'maintain' brings one sheet up to
// date for at most `ms`, 'round' is the background work (dropped keys
// deleted, sheets brought up to date). Every request is answered, an error as
// its message.
import { parentPort } from 'worker_threads';
import { maintainLookupSheet } from './lookup-maintain';
import { lookupBackgroundRound } from './lookup-purge';

export type LookupAsk =
  | { id: number; kind: 'maintain'; sheetId: string; userId: string; ms: number }
  | { id: number; kind: 'round' };
export type LookupReply = { id: number; state?: 'ready' | 'later'; error?: string };

let queue: Promise<void> = Promise.resolve();

async function answer(ask: LookupAsk): Promise<LookupReply> {
  try {
    if (ask.kind === 'round') {
      await lookupBackgroundRound();
      return { id: ask.id };
    }
    return { id: ask.id, state: await maintainLookupSheet(ask.sheetId, ask.userId, Date.now() + ask.ms) };
  } catch (err) {
    return { id: ask.id, error: String((err as Error)?.message ?? err) };
  }
}

parentPort?.on('message', (ask: LookupAsk) => {
  queue = queue.then(async () => { parentPort!.postMessage(await answer(ask)); });
});
parentPort?.postMessage('ready');
