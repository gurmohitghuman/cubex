import { db } from '../lib/db';
import { getRunStatusAndGen } from './http-runner-status';
import { markAutorunInputs } from '../lib/autorun-mark';
import type { RowStamp } from '../lib/run-inputs/stamp';
import { writeRunCells } from '../lib/run-cells-write';
import type { RunRef } from '../lib/run-undo/journal';

// Writers shared by HTTP and enrichment rows (split out of http-row.ts).

// True if the worker no longer owns the run: paused, cancelled, gone, or a
// resume bumped the generation (see ai-runner for the race this closes).
export const shouldStopHttpRun = (runId: string, capturedGeneration: number): boolean => {
  const cur = getRunStatusAndGen(runId);
  if (cur === null) return true;
  if (cur.status === 'paused' || cur.status === 'cancelled') return true;
  return cur.generation !== capturedGeneration;
};

// Apply a {columnName: value} map to one row in a single json_set call
// (lib/run-cells-write.ts quotes the names, so dotted/bracketed ones work).
// Call inside the result's write transaction: a column another column's
// auto-run reads queues this row for it (lib/autorun-mark.ts). stamp: what the
// row's result is made from (lib/run-inputs), written in the same UPDATE.
// runId: the HTTP-family run writing them (kept for its undo).
export const writeRowColumns = (
  runId: string, sheetId: string, userId: string, rowIndex: number,
  values: Array<[string, string]>, stamp?: RowStamp,
) => {
  if (values.length === 0) return;
  const run: RunRef = { kind: 'http', id: runId };
  // Nothing once the run was undone: its cells stay as the undo left them.
  if (!writeRunCells(run, sheetId, userId, rowIndex, values, stamp)) return;
  markAutorunInputs(sheetId, userId, values.map(([col]) => col), { indexes: [rowIndex] });
};
