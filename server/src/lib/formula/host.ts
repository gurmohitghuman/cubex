// The API thread's side of the formula worker (worker.ts): it starts the
// worker (async, once), asks it synchronously with a wall-clock cap, and stops
// it when a request runs past the cap; QuickJS's own deadline can't stop a long
// built-in call. Stopping it closes every formula open in it: `gen` moves on,
// and each sandbox (sandbox.ts) opens again before its next slice. The worker
// stops itself too when its WASM instance breaks (it sets CLOSING first).
// Waiting blocks the API thread, as working the rows out on it would, but
// never longer than the cap.
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from 'worker_threads';
import { extname, join } from 'path';
import { FORMULA_WORKER_HEAP_MB } from '../constants-formula';
import { CLOSING, PROGRESS, READY, SLOTS, type Ask, type Dispose, type Reply } from './protocol';

export type Answer = Reply | { timedOut: number } | { gone: true };

// The worker's file next to this one: worker.ts under tsx, worker.js once built.
const workerFile = (): string => join(__dirname, `worker${extname(__filename)}`);

class FormulaHost {
  gen = 0;
  private worker: Worker | null = null;
  private port: MessagePort | null = null;
  private flags: Int32Array | null = null;
  private starting: Promise<void> | null = null;
  private seq = 0;

  // The worker, started if need be; its generation.
  async ready(): Promise<number> {
    if (this.worker && this.flags && Atomics.load(this.flags, CLOSING) === 1) this.stop();
    if (this.worker) return this.gen;
    this.starting ??= this.start().finally(() => { this.starting = null; });
    await this.starting;
    return this.gen;
  }

  private start(): Promise<void> {
    const flags = new Int32Array(new SharedArrayBuffer(SLOTS * 4));
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(workerFile(), {
      workerData: { port: port2, shared: flags.buffer }, transferList: [port2],
      resourceLimits: { maxOldGenerationSizeMb: FORMULA_WORKER_HEAP_MB },
    });
    return new Promise((resolve, reject) => {
      worker.on('message', m => {
        if (m !== 'ready') return;
        Object.assign(this, { worker, port: port1, flags });
        // Started: from now on the worker never keeps Cubex running (while it
        // starts it does, so a caller waiting for it isn't left behind).
        worker.unref();
        port1.unref();
        resolve();
      });
      worker.on('error', err => console.error('The formula engine failed:', err));
      worker.on('exit', () => {
        if (this.worker === worker) this.drop();
        reject(new Error('The formula engine stopped while starting.'));
      });
    });
  }

  // Synchronous: the answer, or timedOut (the row it was on; the worker is
  // stopped), or gone (no worker: open again after ready()).
  request(msg: Ask, capMs: number): Answer {
    const { worker, port, flags } = this;
    if (!worker || !port || !flags || Atomics.load(flags, CLOSING) === 1) {
      this.stop();
      return { gone: true };
    }
    Atomics.store(flags, READY, 0);
    Atomics.store(flags, PROGRESS, -1);
    const seq = ++this.seq;
    port.postMessage({ ...msg, seq });
    if (Atomics.wait(flags, READY, 0, capMs) === 'timed-out') {
      const at = Atomics.load(flags, PROGRESS);
      this.stop();
      return { timedOut: at };
    }
    for (;;) {
      const m = receiveMessageOnPort(port);
      if (!m) { this.stop(); return { gone: true }; }
      if ((m.message as Reply).seq === seq) return m.message as Reply;
    }
  }

  // No answer (dispose).
  post(msg: Dispose): void {
    this.port?.postMessage(msg);
  }

  private drop(): void {
    Object.assign(this, { worker: null, port: null, flags: null });
    this.gen++;
  }

  private stop(): void {
    const w = this.worker;
    if (!w) return;
    this.drop();
    void w.terminate();
  }
}

export const formulaHost = new FormulaHost();
