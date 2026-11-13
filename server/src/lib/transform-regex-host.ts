// regex_extract off the API thread, for transform_column (services/column-transform.ts). Node can't stop a regex on
// the thread running it, and a pattern can backtrack for seconds to hours on a long cell, though no group repeats a
// quantifier (the guard in transform-ops.ts refuses those): parts that match the same text more than one way
// (\d+\d+b, a*a*b, \d{0,200}\d{0,200}\d{0,200}b), or one unbounded part (.*@, \S+@\S+) on a long cell with no
// match, which is slow, not stuck. On the API thread, inside a page's write transaction, that held the server and
// SQLite's write lock as long. So a call that extracts gets a worker thread of its own (transform-regex-worker.ts),
// started at its first page: each page's cells go to it before the page's transaction, and it answers each cell
// as it works it out. A page it hasn't finished within TRANSFORM_REGEX_PAGE_MS ends with the cells it did: the
// worker is terminated, which stops a running match at once, and the next page starts another, with the cell that
// was running first and the whole time again (column-transform-pages.ts). A page that gets no cell done, its first
// one alone taking that long, stops the call with SlowPattern. The API thread never waits for the worker: it
// answers other requests meanwhile.
import { Worker, type WorkerOptions } from 'worker_threads';
import { extname, join } from 'path';
import { TRANSFORM_REGEX_PAGE_MS, TRANSFORM_REGEX_WORKER_HEAP_MB } from './api-v1-constants';
import type { RegexAsk, RegexReply } from './transform-regex-worker';

const seconds = TRANSFORM_REGEX_PAGE_MS / 1000;
// What to send instead (the call's answer adds why it stopped and what was written).
export const SLOW_PATTERN_FIX = 'A pattern takes that long on a long cell when it can try many ways to match: parts '
  + 'that can match the same text more than one way (\\d+\\d+, a*a*), or a part like .* or \\S+ at its start when '
  + 'the cell has no match. Anchor it with ^, simplify it, or use where to keep the rows that hold what it looks for.';

// A row whose cell alone took the pattern longer than TRANSFORM_REGEX_PAGE_MS.
export class SlowPattern extends Error {
  readonly why: string;
  constructor(rowId: string) {
    const why = `the pattern took more than ${seconds} second${seconds === 1 ? '' : 's'} on the cell of row ${rowId}`;
    super(`regex_extract stopped: ${why}.`);
    this.why = why;
  }
}

export interface RegexPages {
  // What regex_extract takes from each value, in order, as far as the worker got within TRANSFORM_REGEX_PAGE_MS:
  // fewer than the values (none, when the first alone took that long) once the time ran out.
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
    const failed = (e: unknown): void => {
      worker.off('message', started);
      reject(e instanceof Error ? e : new Error(`The regex worker stopped while starting (exit code ${String(e)}).`));
    };
    const started = (): void => {
      worker.off('error', failed);
      worker.off('exit', failed);
      resolve(worker);
    };
    worker.once('message', started);
    worker.once('error', failed);
    worker.once('exit', failed);
  });
}

// One call's worker for `pattern`, started at the first extract, and again after a page that ran out of time.
export function regexPages(pattern: string): RegexPages {
  let current: Promise<Worker> | null = null;
  let closed = false;
  let seq = 0;
  const stop = (): void => {
    const w = current;
    current = null;
    void w?.then(s => s.terminate(), () => {});
  };
  const close = (): void => {
    closed = true;
    stop();
  };
  const ready = async (): Promise<Worker> => {
    if (closed) throw new Error('This call\'s regex worker is closed.');
    current ??= startWorker();
    const mine = current;
    const started = await mine;
    if (closed || current !== mine) throw new Error('This call\'s regex worker is closed.');
    return started;
  };
  const extract = async (values: string[]): Promise<string[]> => {
    if (values.length === 0) return [];
    const w = await ready();
    const ask: RegexAsk = { seq: ++seq, pattern, values };
    const results: string[] = [];
    return new Promise<string[]>((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        w.off('message', onMessage);
        w.off('error', onFailure);
        w.off('exit', onFailure);
      };
      const onMessage = (m: RegexReply): void => {
        if (m.seq !== ask.seq) return;
        results.push(m.result);
        if (results.length < values.length) return;
        done();
        resolve(results);
      };
      const onFailure = (e: unknown): void => {
        done();
        close();
        reject(e instanceof Error ? e : new Error(`The regex worker stopped (exit code ${String(e)}).`));
      };
      // Out of time: the cells it finished, and the worker stopped mid-cell.
      const timer = setTimeout(() => {
        done();
        stop();
        resolve(results);
      }, TRANSFORM_REGEX_PAGE_MS);
      w.on('message', onMessage);
      w.once('error', onFailure);
      w.once('exit', onFailure);
      w.postMessage(ask);
    });
  };
  return { extract, close };
}
