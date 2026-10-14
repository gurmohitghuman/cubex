// The formula worker: a thread of its own where formulas run (qjs.ts), so the
// API thread can stop one that runs too long by wall clock. QuickJS's own
// deadline can't: it isn't checked inside a long built-in call (an indexOf or a
// split over a huge string). The API thread asks synchronously (host.ts); each
// answer goes over the port, then READY wakes it. A run works out rows until
// its time budget (always at least one), noting each row in PROGRESS first, so
// the API thread knows which row hung when it has to stop the worker.
import { parentPort, workerData, type MessagePort } from 'worker_threads';
import type { QuickJSWASMModule } from 'quickjs-emscripten-core';
import type { FormulaOutcome } from './cells';
import { CompileFault, QjsSandbox, loadQuickJS } from './qjs';
import { CLOSING, PROGRESS, READY, type Ask, type Reply, type Request } from './protocol';

const { port, shared } = workerData as { port: MessagePort; shared: SharedArrayBuffer };
const flags = new Int32Array(shared);
const sandboxes = new Map<number, QjsSandbox>();

// fault: the WASM instance broke; the worker answers, then stops.
function handle(mod: QuickJSWASMModule, msg: Ask & { seq: number }): { reply: Reply; fault: boolean } {
  if (msg.op === 'open') {
    sandboxes.get(msg.sid)?.dispose();
    sandboxes.delete(msg.sid);
    try {
      sandboxes.set(msg.sid, new QjsSandbox(mod, msg.source, msg.usesLodash));
      return { reply: { seq: msg.seq, ok: true }, fault: false };
    } catch (e) {
      if (e instanceof CompileFault) return { reply: { seq: msg.seq, error: e.message }, fault: false };
      return { reply: { seq: msg.seq, error: 'The formula went too deep' }, fault: true };
    }
  }
  const sandbox = sandboxes.get(msg.sid);
  if (!sandbox) return { reply: { seq: msg.seq, closed: true }, fault: false };
  const outcomes: FormulaOutcome[] = [];
  const until = Date.now() + msg.budgetMs;
  for (let i = 0; i < msg.rows.length; i++) {
    if (i > 0 && Date.now() >= until) break;
    Atomics.store(flags, PROGRESS, i);
    const r = sandbox.run(msg.rows[i]);
    outcomes.push(r.outcome);
    if (r.host) return { reply: { seq: msg.seq, outcomes }, fault: true };
  }
  return { reply: { seq: msg.seq, outcomes }, fault: false };
}

loadQuickJS().then(mod => {
  port.on('message', (msg: Request) => {
    if (msg.op === 'dispose') {
      sandboxes.get(msg.sid)?.dispose();
      sandboxes.delete(msg.sid);
      return;
    }
    const { reply, fault } = handle(mod, msg);
    if (fault) Atomics.store(flags, CLOSING, 1);
    port.postMessage(reply);
    Atomics.store(flags, READY, 1);
    Atomics.notify(flags, READY);
    if (fault) process.exit(0);
  });
  parentPort?.postMessage('ready');
}, err => {
  console.error('The formula engine could not load:', err);
  process.exit(1);
});
