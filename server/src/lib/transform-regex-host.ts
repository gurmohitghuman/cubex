// regex_extract off the API thread, for transform_column (services/column-transform.ts). Node can't stop a regex on
// the thread running it, and a pattern whose parts can match the same text more than one way (\d+\d+b, a*a*b,
// \d{0,200}\d{0,200}b) backtracks for seconds to hours on a long cell, though no group repeats a quantifier (the
// guard in transform-ops.ts refuses those). On the API thread, inside a page's write transaction, that held the
// server and SQLite's write lock as long. So a call that extracts gets a worker thread of its own
// (transform-regex-worker.ts), started at its first page: each page's cells go to it before the page's transaction,
// and the page reads its answers (column-transform-pages.ts). A page it hasn't answered within
// TRANSFORM_REGEX_PAGE_MS ends the call: the worker is terminated, which stops a running match at once, and the
// call answers SLOW_PATTERN. The API thread never waits for the worker: it answers other requests meanwhile.
import { Worker, type WorkerOptions } from 'worker_threads';
import { extname, join } from 'path';
import { TRANSFORM_PAGE_ROWS, TRANSFORM_REGEX_PAGE_MS, TRANSFORM_REGEX_WORKER_HEAP_MB } from './api-v1-constants';
import type { RegexAsk, RegexReply } from './transform-regex-worker';

const seconds = TRANSFORM_REGEX_PAGE_MS / 1000;
// Why a page stopped, and what to send instead (the call's answer adds what was written).
export const SLOW_PATTERN_WHY = `the pattern took more than ${seconds} second${seconds === 1 ? '' : 's'} on one `
  + `page of up to ${TRANSFORM_PAGE_ROWS} cells`;
export const SLOW_PATTERN_FIX = 'A pattern whose parts can match the same text in more than one way, such as '
  + '"\\d+\\d+" or "a*a*", can take that long on long cells. Simplify it, or limit the rows with where.';

export class SlowPattern extends Error {
  constructor() { super(`regex_extract stopped: ${SLOW_PATTERN_WHY}.`); }
}

export interface RegexPages {
  // What regex_extract takes from each value, in order. Rejects with SlowPattern past the cap.
  extract(values: string[]): Promise<string[]>;
  // Stops the worker. Call it when the call ends, however it ends.
  close(): void;
}

// The worker's file next to this one: .ts under tsx (the dev server, the tests), .js once built. From source the
// worker registers tsx itself: a worker thread doesn't get the parent's loaders (formula/host.ts does the same).
function newWorker(opts: WorkerOptions): Worker {
  const file = join(__dirname, `transform-regex-worker${extname(__filename)}`);
  if (!file.endsWith('.ts')) return new Worker(file, opts);
  const tsx = require.resolve('tsx/cjs/api');
  return new Worker(`require(${JSON.stringify(tsx)}).register(); require(${JSON.stringify(file)});`,
    { ...opts, eval: true });
}

function startWorker(): Promise<Worker> {
  const worker = newWorker({ resourceLimits: { maxOldGenerationSizeMb: TRANSFORM_REGEX_WORKER_HEAP_MB } });
  return new Promise((resolve, reject) => {
    worker.once('message', () => resolve(worker));
    worker.once('error', reject);
    worker.once('exit', code => reject(new Error(`The regex worker stopped while starting (exit code ${code}).`)));
  });
}

// One call's worker for `pattern`, started at the first extract.
export function regexPages(pattern: string): RegexPages {
  let worker: Worker | null = null;
  let starting: Promise<Worker> | null = null;
  let closed = false;
  let seq = 0;
  const close = (): void => {
    closed = true;
    const w = worker;
    worker = null;
    if (w) void w.terminate();
    else void starting?.then(s => s.terminate(), () => {});
  };
  const ready = async (): Promise<Worker> => {
    if (closed) throw new Error('This call\'s regex worker is closed.');
    starting ??= startWorker();
    const started = await starting;
    if (closed) throw new Error('This call\'s regex worker is closed.');
    worker = started;
    return started;
  };
  const extract = async (values: string[]): Promise<string[]> => {
    const w = await ready();
    const ask: RegexAsk = { seq: ++seq, pattern, values };
    return new Promise<string[]>((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        w.off('message', onMessage);
        w.off('error', onFailure);
        w.off('exit', onFailure);
      };
      const onMessage = (m: RegexReply): void => {
        if (m.seq !== ask.seq) return;
        done();
        resolve(m.results);
      };
      const onFailure = (e: unknown): void => {
        done();
        close();
        reject(e instanceof Error ? e : new Error(`The regex worker stopped (exit code ${String(e)}).`));
      };
      const timer = setTimeout(() => { done(); close(); reject(new SlowPattern()); }, TRANSFORM_REGEX_PAGE_MS);
      w.on('message', onMessage);
      w.once('error', onFailure);
      w.once('exit', onFailure);
      w.postMessage(ask);
    });
  };
  return { extract, close };
}
