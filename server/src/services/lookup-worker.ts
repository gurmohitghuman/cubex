// The lookup worker thread (started by services/lookup-host.ts): keeps
// looked-up sheets' keys current on its own database connection (lib/db.ts,
// the same settings), and auto-dedupe sheets' keys too
// (services/auto-dedupe-index.ts), one request at a time: 'maintain' brings
// one looked-up sheet up to date for at most `ms`, 'dedupe' one auto-dedupe
// sheet, 'round' is the background work (dropped keys deleted, sheets brought
// up to date). Every request is answered, an error as its message.
import { parentPort } from 'worker_threads';
import { maintainLookupSheet } from './lookup-maintain';
import { lookupBackgroundRound } from './lookup-purge';
import { maintainAutoDedupeSheet } from './auto-dedupe-index';
import { autoDedupeBackgroundRound } from './auto-dedupe-purge';

export type LookupAsk =
  | { id: number; kind: 'maintain' | 'dedupe'; sheetId: string; userId: string; ms: number }
  | { id: number; kind: 'round' };
export type LookupReply = { id: number; state?: 'ready' | 'later'; error?: string };

let queue: Promise<void> = Promise.resolve();

async function answer(ask: LookupAsk): Promise<LookupReply> {
  try {
    if (ask.kind === 'round') {
      await lookupBackgroundRound();
      await autoDedupeBackgroundRound();
      return { id: ask.id };
    }
    const maintain = ask.kind === 'dedupe' ? maintainAutoDedupeSheet : maintainLookupSheet;
    return { id: ask.id, state: await maintain(ask.sheetId, ask.userId, Date.now() + ask.ms) };
  } catch (err) {
    return { id: ask.id, error: String((err as Error)?.message ?? err) };
  }
}

parentPort?.on('message', (ask: LookupAsk) => {
  queue = queue.then(async () => { parentPort!.postMessage(await answer(ask)); });
});
parentPort?.postMessage('ready');
