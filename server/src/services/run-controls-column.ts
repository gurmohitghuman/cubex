// Which run fills a column, for the column menu's run controls, the header's
// "N failed, retry" and a cell's play button (services/run-controls.ts): the
// run's kind and its main column (the one holding its per-row state, where
// reruns choose rows and fingerprints are kept), from any of its columns.
import { sheetColumnKinds } from '../lib/column-types';
import { getSheetColumns } from '../lib/sql-helpers';
import { liveRunColumns } from './row-filter';

export type RunKind = 'ai' | 'http' | 'enrichment' | 'waterfall';
export interface RunColumn { kind: RunKind; main: string }

const KIND_OF: Record<string, RunKind> = {
  'ai-output': 'ai', 'http-master': 'http', 'enrich-status': 'enrichment', waterfall: 'waterfall',
};

// The sheet's run columns: each main column → its kind (main columns only).
export function sheetRunMains(sheetId: string, userId: string): Map<string, RunKind> {
  const kinds = sheetColumnKinds(sheetId, userId);
  const live = liveRunColumns(kinds.runState, getSheetColumns(sheetId, userId, false));
  const out = new Map<string, RunKind>();
  for (const [column, state] of live) {
    const kind = KIND_OF[kinds.types[column] ?? ''];
    if (state === column && kind) out.set(column, kind);
  }
  return out;
}

export function runColumnOf(sheetId: string, userId: string, column: string): RunColumn | null {
  const kinds = sheetColumnKinds(sheetId, userId);
  const live = liveRunColumns(kinds.runState, getSheetColumns(sheetId, userId, false));
  const main = live.get(column);
  const kind = main === undefined ? undefined : KIND_OF[kinds.types[main] ?? ''];
  return main !== undefined && kind ? { kind, main } : null;
}
