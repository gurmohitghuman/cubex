// What a reader or a writer is told when a column it needs is held by a run
// (lib/run-locked-columns.ts runHeldColumns with clearing: true): a run still
// going on it, or a stopped or failed one putting back what its ⏳ cells held
// before it. One place, so every site says it the same way.
import type { RunHold } from './run-locked-columns';

// A start, rerun, resume or preview that would send a held column's cells (an AI prompt, an HTTP request).
// reader: what reads it, such as `/answer` or `The request`.
export function heldReadWords(reader: string, column: string, hold: RunHold): string {
  return hold === 'going'
    ? `${reader} reads "${column}", which a run that hasn't finished is still filling. `
      + 'Wait for that run to finish (or stop it), then try again.'
    : `${reader} reads "${column}", which is getting back what it held before a stopped run. Try again in a moment.`;
}

// A column copied or written at once (transform_column, transfer_rows).
export const heldColumnWords = (column: string, hold: RunHold): string => (hold === 'going'
  ? `Column "${column}" is being written by a run that hasn't finished. Wait for it to finish (or stop it) first.`
  : `Column "${column}" is getting back what it held before a stopped run. Try again in a moment.`);
