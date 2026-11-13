// The worker thread transform_column's regex_extract runs on (transform-regex-host.ts): it answers a page's cells
// one at a time, as it works each out, with what applyCellOp extracts from it, the same as on the API thread. Run
// here, a pattern that backtracks for minutes holds only this thread, and the host stops it.
import { parentPort } from 'worker_threads';
import { applyCellOp } from './transform-ops';

export interface RegexAsk { seq: number; pattern: string; values: string[] }
export interface RegexReply { seq: number; result: string }

if (parentPort) {
  const port = parentPort;
  port.on('message', ({ seq, pattern, values }: RegexAsk) => {
    for (const value of values) {
      port.postMessage({ seq, result: applyCellOp('regex_extract', value, { pattern }) } satisfies RegexReply);
    }
  });
  port.postMessage('ready');
}
