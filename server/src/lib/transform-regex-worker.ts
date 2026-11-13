// The worker thread transform_column's regex_extract runs on (transform-regex-host.ts): it answers a page's cells
// with what applyCellOp extracts from each, the same as on the API thread. Run here, a pattern that backtracks for
// minutes holds only this thread, and the host stops it.
import { parentPort } from 'worker_threads';
import { applyCellOp } from './transform-ops';

export interface RegexAsk { seq: number; pattern: string; values: string[] }
export interface RegexReply { seq: number; results: string[] }

if (parentPort) {
  const port = parentPort;
  port.on('message', ({ seq, pattern, values }: RegexAsk) => {
    const results = values.map(value => applyCellOp('regex_extract', value, { pattern }));
    port.postMessage({ seq, results } satisfies RegexReply);
  });
  port.postMessage('ready');
}
