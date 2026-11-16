// Jobs go into the job queue's database (jobs.db) from a worker thread with a connection of its own
// (lib/job-insert-worker.ts), not from the server's. In WAL mode (lib/jobs-db.ts) a commit makes no sync, but the
// first commit after any connection's full checkpoint starts the WAL over and syncs it, and one in about 1,000
// pages runs the checkpoint (2 syncs). Made on the server's thread inside a run's queuing, either held the server
// as long as a slow disk takes.
// - The job is built here with the queue library's own builder (no file access; its defaults are the ones the
//   library's own Sidequest.build gives, since Cubex sets none) and inserted there with its own insert, in the order
//   asked: the queue starts waiting jobs in the order they were inserted. The queue call waits, the loop free.
// - Without a worker (the queue not started, a test standing in for it), a queue call is the library's own enqueue
//   on this thread, as before. A worker that can't start, or stops, leaves the inserts to this thread from then on
//   (logged once); those it hadn't answered are made here first, in order. One it made just before stopping is then
//   there twice, and a run starts once (from pending, at its generation): only one of them works.
// - Stopping (closeJobInserts) waits up to JOB_INSERTS_DRAIN_MS for the inserts already asked. One that didn't land
//   by then counts as queued: its run is still pending in cubex.db, and every start queues each pending run again
//   at a new generation (lib/orphan-runs.ts), so a job left from before a stop never runs anyway. A queue call made
//   once stopping began fails, as one did once the queue had stopped.
import { Worker } from 'worker_threads';
import { extname, join } from 'path';
import { JobBuilder, Sidequest, type Backend, type JobClassType, type JobData, type NewJobData } from 'sidequest';
import { JOB_INSERTS_DRAIN_MS } from './constants';
import type { InsertAsk, InsertReply } from './job-insert-worker';

type Waiting = { job: NewJobData; resolve: () => void; reject: (e: Error) => void };
let worker: Worker | null = null;
let onMainThread = false;
let closed = false;
let seq = 0;
let delayMs = 0;
let drainMs = JOB_INSERTS_DRAIN_MS;
const waiting = new Map<number, Waiting>();
// Inserts made on this thread, one after another in the order asked.
let here: Promise<void> = Promise.resolve();

// The worker's file next to this one: .ts under tsx (it registers tsx itself), .js once built.
const ownWorkerFile = (): string => join(__dirname, `job-insert-worker${extname(__filename)}`);
let workerFile = ownWorkerFile;
function newWorker(file: string): Worker {
  const path = workerFile();
  if (!path.endsWith('.ts')) return new Worker(path, { workerData: { file } });
  const tsx = require.resolve('tsx/cjs/api');
  return new Worker(`require(${JSON.stringify(tsx)}).register(); require(${JSON.stringify(path)});`,
    { eval: true, workerData: { file } });
}

function onThisThread(work: () => Promise<unknown>): Promise<void> {
  const done = here.then(async () => { await work(); });
  here = done.catch(() => {});
  return done;
}
function insertHere(job: NewJobData): Promise<unknown> {
  const backend = Sidequest.getBackend();
  if (!backend) throw new Error('The job queue is not running.');
  return backend.createNewJob(job);
}

function fallBack(why: string, err?: unknown): void {
  if (onMainThread) return;
  onMainThread = true;
  const w = worker;
  worker = null;
  console.error(`The job queue's insert worker ${why}; jobs are inserted on the server's thread from now on.`,
    err ?? '');
  void w?.terminate();
  const left = [...waiting.values()];
  waiting.clear();
  for (const e of left) onThisThread(() => insertHere(e.job)).then(e.resolve, e.reject);
}

// Called once the queue has started (its tables exist): the worker opens jobs.db when the first job comes.
export function startJobInserts(file: string): void {
  closed = false;
  if (worker || onMainThread) return;
  try {
    const w = newWorker(file);
    w.on('message', (m: InsertReply) => {
      if (m === 'closed') return;
      const e = waiting.get(m.id);
      if (!e) return;
      waiting.delete(m.id);
      if (m.error) e.reject(new Error(m.error)); else e.resolve();
    });
    w.on('error', err => { if (worker === w) fallBack('stopped with an error', err); });
    w.on('exit', code => { if (worker === w) fallBack(`stopped (exit code ${code})`); });
    worker = w;
  } catch (err) {
    fallBack('couldn\'t start', err);
  }
}

function insert(job: NewJobData): Promise<void> {
  const w = worker;
  if (!w) return onThisThread(() => insertHere(job));
  return new Promise<void>((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { job, resolve, reject });
    w.postMessage({ id, job, delayMs } satisfies InsertAsk);
  });
}

// The builder calls nothing else on its backend.
const throughInserts = {
  createNewJob: async (job: NewJobData) => { await insert(job); return job as unknown as JobData; },
} as unknown as Backend;

// Queues a job of `JobClass` with `args` (queue.ts): built here, inserted on the worker.
export async function enqueueJob<T extends JobClassType>(
  JobClass: T, ...args: Parameters<InstanceType<T>['run']>
): Promise<void> {
  if (closed) throw new Error('The job queue is stopping; the job wasn\'t queued.');
  if (!worker) return onThisThread(() => Sidequest.build(JobClass).enqueue(...args));
  await new JobBuilder(throughInserts, JobClass, undefined, true).enqueue(...args);
}

export async function closeJobInserts(): Promise<void> {
  closed = true;
  const w = worker;
  worker = null;
  if (w) {
    let timer: NodeJS.Timeout | undefined;
    const exited = new Promise<boolean>(r => { w.once('exit', () => r(true)); });
    w.postMessage('close' satisfies InsertAsk);
    const late = new Promise<boolean>(r => { timer = setTimeout(() => r(false), drainMs); });
    if (!await Promise.race([exited, late])) {
      console.error(`The job queue's insert worker didn't finish within ${drainMs} ms; stopped. The runs whose `
        + 'jobs it hadn\'t inserted are pending, and the next start queues them again.');
      await w.terminate();
    }
    clearTimeout(timer);
  }
  for (const e of waiting.values()) e.resolve();
  waiting.clear();
  await here;
}

// Tests only: the state now, a hold on each insert (as a slow disk), a shorter drain, another worker file (null:
// the real one), the worker stopped as a crash would, and a fresh start after a fallback.
export const jobInsertsOnWorker = (): boolean => worker !== null;
export function setJobInsertsForTests(o: { delayMs?: number; drainMs?: number; workerFile?: string | null }): void {
  if (o.delayMs !== undefined) delayMs = o.delayMs;
  if (o.drainMs !== undefined) drainMs = o.drainMs;
  if (o.workerFile !== undefined) { const file = o.workerFile; workerFile = file ? () => file : ownWorkerFile; }
}
export async function stopJobInsertWorkerForTests(): Promise<void> { await worker?.terminate(); }
export function resetJobInsertsForTests(): void { onMainThread = false; closed = false; }
