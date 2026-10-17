// Ready-made views, made only when someone picks one (never on every sheet):
// "Rows with errors" (any run column has an error) and "Fully filled rows"
// (every run column has a result). Picking one that already exists switches
// to it. Run columns: AI, HTTP API and enrichment columns (row-filter.ts).
import { getSheetColumns } from '../lib/sql-helpers';
import { MAX_WHERE_CONDITIONS } from '../lib/constants-filters';
import type { WhereItem } from '../lib/row-filter/where';
import { sheetRunColumns } from './row-filter';
import { activateView, createView, type ViewOutcome } from './views';
import { ensuredViewRows, sheetViewState } from './view-store';

export const VIEW_STARTERS = {
  errors: {
    name: 'Rows with errors',
    description: 'Rows where an AI, HTTP API or enrichment column has an error.',
  },
  filled: {
    name: 'Fully filled rows',
    description: 'Rows where every AI, HTTP API and enrichment column has a result.',
  },
} as const;
export type ViewStarter = keyof typeof VIEW_STARTERS;
export const isViewStarter = (v: unknown): v is ViewStarter => v === 'errors' || v === 'filled';

export function pickViewStarter(sheetId: string, userId: string, kind: ViewStarter): ViewOutcome {
  if (!sheetViewState(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const starter = VIEW_STARTERS[kind];
  const existing = ensuredViewRows(sheetId, userId).find(r => r.name.toLowerCase() === starter.name.toLowerCase());
  if (existing) return activateView(sheetId, userId, existing.id);
  const runColumns = sheetRunColumns(sheetId, userId, getSheetColumns(sheetId, userId, false));
  if (runColumns.size === 0) {
    return { fail: 'bad_request', message: 'This sheet has no AI, HTTP API or enrichment columns yet.' };
  }
  if (kind === 'filled' && runColumns.size > MAX_WHERE_CONDITIONS) {
    return { fail: 'bad_request', message: `"Fully filled rows" can check at most ${MAX_WHERE_CONDITIONS} AI, `
      + `HTTP API and enrichment columns; this sheet has ${runColumns.size}.` };
  }
  // Errors: one check over every run column there is when the view is read.
  // Filled: one condition per run column there is now, each shown on its header.
  const where: WhereItem[] = kind === 'errors'
    ? [{ operator: 'has_error' }]
    : [...runColumns.keys()].map(column => ({ column, operator: 'has_result' as const }));
  return createView(sheetId, userId, { ...starter, where, hidden_columns: null, activate: true });
}
