// What a setup call (services/setup-call.ts) answers when read: its setup run's status and steps, and once it has
// finished, its items' outputs a page at a time (SETUP_CALL_MAX_ITEMS at most), read from its working table by row
// index: an item's number is its row's index, so a page goes on from the last item it gave, at any size.
import { db } from '../lib/db';
import { SETUP_CALL_KEEP_HOURS, SETUP_CALL_MAX_ITEMS } from '../lib/constants-setups';
import { stepColumns, type SetupSpec } from '../lib/setups/spec';
import { callItem, type SetupCallItem } from '../lib/setups/call-item';
import { getSetupRun, loadSetupRun, type SetupRunView } from './setup-run-store';

export type { SetupCallItem } from '../lib/setups/call-item';
export interface SetupCallView {
  id: string; setup_id: string | null; setup_name: string; status: SetupRunView['status']; items: number;
  layer: number; layers: number; error_message: string | null; created_at: string; updated_at: string;
  // When the results go (null while it runs): SETUP_CALL_KEEP_HOURS after it finished.
  keep_until: string | null;
  webhook_id: string | null; max_cost_usd?: number;
  steps: Array<Pick<SetupRunView['steps'][number], 'column' | 'kind' | 'layer' | 'state' | 'run_id' | 'note'>>;
  // Once it has finished (done, failed or cancelled): the items from results_from, in order, and where the next
  // page starts (null when this one ends them).
  results?: SetupCallItem[];
  next_from?: number | null;
}
export interface ResultsPage { from?: number; limit?: number }

export const CALL_NOT_FOUND =
  `Setup call not found: results are kept ${SETUP_CALL_KEEP_HOURS} hours after a call finishes.`;
const FINISHED = new Set(['done', 'failed', 'cancelled']);

// SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) plus hours, as ISO.
const plusHours = (at: string, hours: number): string =>
  new Date(Date.parse(`${at.replace(' ', 'T')}Z`) + hours * 3_600_000).toISOString();

// A page of items' status and outputs: every column the setup's steps make, from the working table's rows by index.
function resultsOf(userId: string, sheetId: string, spec: SetupSpec, page: ResultsPage) {
  const columns = [...new Set(spec.steps.flatMap(stepColumns))];
  const limit = Math.min(SETUP_CALL_MAX_ITEMS, Math.max(1, page.limit ?? SETUP_CALL_MAX_ITEMS));
  const rows = db.prepare(`SELECT row_index, data FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index >= ?
    ORDER BY row_index LIMIT ?`).all(sheetId, userId, Math.max(0, page.from ?? 0), limit + 1) as
    Array<{ row_index: number; data: string }>;
  const results = rows.slice(0, limit).map(r => {
    let cells: Record<string, unknown> = {};
    try { cells = JSON.parse(r.data) as Record<string, unknown>; } catch { /* an unreadable row reads as empty */ }
    return callItem(r.row_index, cells, columns);
  });
  return { results, next_from: rows.length > limit ? rows[limit].row_index : null };
}

export function getSetupCall(userId: string, id: string, page: ResultsPage = {}): SetupCallView | null {
  const call = db.prepare('SELECT sheet_id, items FROM setup_calls WHERE id = ? AND user_id = ?').get(id, userId) as
    { sheet_id: string; items: number } | undefined;
  const run = call && getSetupRun(userId, id);
  if (!call || !run) return null;
  const finished = FINISHED.has(run.status);
  const record = loadSetupRun(id)!;
  return {
    id, setup_id: run.setup_id, setup_name: run.setup_name, status: run.status, items: call.items,
    layer: run.layer, layers: run.layers, error_message: run.error_message, created_at: run.created_at,
    updated_at: run.updated_at,
    keep_until: finished ? plusHours(record.updated_at, SETUP_CALL_KEEP_HOURS) : null,
    webhook_id: run.webhook_id, ...(run.max_cost_usd !== undefined ? { max_cost_usd: run.max_cost_usd } : {}),
    steps: run.steps.map(s => ({ column: s.column, kind: s.kind, layer: s.layer, state: s.state, run_id: s.run_id,
      note: s.note })),
    ...(finished ? resultsOf(userId, call.sheet_id, (JSON.parse(record.plan) as { spec: SetupSpec }).spec, page) : {}),
  };
}

// The working sheet of a call the user has (a download link reads it), or null.
export const setupCallSheet = (userId: string, id: string): string | null =>
  (db.prepare('SELECT sheet_id FROM setup_calls WHERE id = ? AND user_id = ?').pluck().get(id, userId) as
    string | undefined) ?? null;
