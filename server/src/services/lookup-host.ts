// The API thread's side of the lookup worker (lookup-worker.ts): started once,
// on first use, and never keeping Cubex running. A looked-up sheet's keys are
// brought up to date there, so a big build (about half a minute for a contains
// index over a million rows) neither runs on the API thread nor makes it wait
// for a WAL checkpoint. If the worker can't run, the same work runs here.
import { Worker } from 'worker_threads';
import { extname, join } from 'path';
import { LOOKUP_PURGE_TICK_MS, LOOKUP_STEP_ROUND_MS } from '../lib/constants';
import { maintainLookupSheet } from './lookup-maintain';
import { checkLookupSources, lookupBackgroundRound } from './lookup-purge';
import type { LookupAsk, LookupReply } from './lookup-worker';

// The worker's file next to this one: .ts under tsx (it registers tsx itself:
// a worker thread doesn't get the parent's loaders), .js once built.
function newWorker(): Worker {
  const file = join(__dirname, `lookup-worker${extname(__filename)}`);
  if (!file.endsWith('.ts')) return new Worker(file);
  const tsx = require.resolve('tsx/cjs/api');
  return new Worker(`require(${JSON.stringify(tsx)}).register(); require(${JSON.stringify(file)});`, { eval: true });
}

type Ask = { kind: 'maintain'; sheetId: string; userId: string; ms: number } | { kind: 'round' };

let worker: Worker | null = null;
let starting: Promise<Worker | null> | null = null;
let seq = 0;
const waiting = new Map<number, (r: LookupReply) => void>();

function start(): Promise<Worker | null> {
  return new Promise(resolve => {
    let w: Worker;
    try { w = newWorker(); } catch (err) {
      console.error('The lookup worker could not start; lookups keep their keys on the main thread:', err);
      resolve(null);
      return;
    }
    w.on('message', (m: LookupReply | 'ready') => {
      if (m === 'ready') { worker = w; w.unref(); resolve(w); return; }
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
    });
    w.on('error', err => console.error('The lookup worker failed:', err));
    w.on('exit', () => {
      if (worker === w) worker = null;
      // Whoever was waiting gets an answer (the work goes on here instead).
      for (const [id, done] of waiting) done({ id, error: 'The lookup worker stopped.' });
      waiting.clear();
      resolve(null);
    });
  });
}

async function ask(a: Ask): Promise<LookupReply> {
  if (!worker) {
    starting ??= start().finally(() => { starting = null; });
    await starting;
  }
  const w = worker;
  if (!w) return { id: 0, error: 'no worker' };
  const id = ++seq;
  return new Promise(resolve => {
    waiting.set(id, resolve);
    // A pending answer keeps the process alive only while it is awaited.
    w.ref();
    w.postMessage({ id, ...a } as LookupAsk);
  }).finally(() => { if (waiting.size === 0) w.unref(); }) as Promise<LookupReply>;
}

// Brings a looked-up sheet's keys up to date for at most `ms`: 'ready' or 'later'.
export async function maintainLookupInBackground(
  sheetId: string, userId: string, ms: number,
): Promise<'ready' | 'later'> {
  const r = await ask({ kind: 'maintain', sheetId, userId, ms });
  if (r.state) return r.state;
  if (r.error && r.error !== 'no worker' && r.error !== 'The lookup worker stopped.') throw new Error(r.error);
  return maintainLookupSheet(sheetId, userId, Date.now() + ms);
}

// Keeps the worker on one sheet's keys until they are current (one driver per
// sheet): a fill waiting for a big build doesn't hold its own sheet meanwhile.
const driving = new Set<string>();
export function keepMaintaining(sheetId: string, userId: string): void {
  if (driving.has(sheetId)) return;
  driving.add(sheetId);
  void (async () => {
    try {
      while (await maintainLookupInBackground(sheetId, userId, LOOKUP_STEP_ROUND_MS) !== 'ready') { /* next round */ }
    } catch (err) {
      console.error(`Bringing lookup keys of sheet ${sheetId} up to date failed:`, err);
    } finally {
      driving.delete(sheetId);
    }
  })();
}

// At boot (API process): keys checked against their rows, then the background
// work every LOOKUP_PURGE_TICK_MS, in the worker.
let rounding = false;
export function startLookupLoop(): void {
  try { checkLookupSources(); } catch (err) { console.error('Checking lookup keys failed:', err); }
  setInterval(() => {
    if (rounding) return;
    rounding = true;
    ask({ kind: 'round' })
      .then(r => (r.error === 'no worker' ? lookupBackgroundRound() : undefined))
      .catch(err => console.error('Lookup background work failed:', err))
      .finally(() => { rounding = false; });
  }, LOOKUP_PURGE_TICK_MS).unref();
}
