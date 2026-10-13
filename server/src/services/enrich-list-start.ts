// The list part of a run start (services/enrich-run-start.ts): before the
// start transaction, where the rows go and which columns they fill; inside
// it, the new sheet and columns, the run's destination, and the fields given
// to the column's earlier test runs whose results still wait for them.
import { db } from '../lib/db';
import { listOf, type EnrichRunConfig } from '../lib/enrich-run-config';
import type { EnrichRunInput } from '../lib/enrich-run-input';
import { applyListDest, planListDest, type DestPlan } from './enrich-list-dest';
import { fieldlessRuns, giveFields } from './enrich-list-held';
import type { RunFail } from './run-shared';

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

// Results of this column still being added as rows (not those waiting for
// fields, for room or for a paused run on their destination): a new run on it
// waits, as for a run still clearing.
export function listRowsBeingAdded(sheetId: string, userId: string, column: string): string | null {
  const row = db.prepare(`SELECT s.name FROM enrichment_list_items li
    JOIN http_runs r ON r.id = li.run_id JOIN sheets s ON s.id = li.dest_sheet_id
    WHERE li.source_sheet_id = ? AND li.status = 'pending' AND li.wait_reason IS NULL AND li.user_id = ?
      AND r.user_id = ? AND r.master_column_name = ? LIMIT 1`).get(sheetId, userId, userId, column) as
    { name: string } | undefined;
  return row ? `Rows from this column are still being added to ${row.name}. Try again when that finishes.` : null;
}

export function planListStart(
  userId: string, sheetId: string, input: EnrichRunInput, config: EnrichRunConfig, columns: string[],
): { ok: DestPlan | null } | RunFail {
  if (!input.list || !config.enrichment.list) return { ok: null };
  // Fields come from real results: a run without them is a test of a few rows.
  if (!input.list.fields?.length && input.rows.test === null) {
    return bad('Pick the fields to keep first: run on a few rows, then pick them from the results.');
  }
  const plan = planListDest(userId, sheetId, input.list, columns);
  return 'fail' in plan ? plan : { ok: plan.ok };
}

// Inside the start transaction. raced: the caller rolls the transaction back.
export function applyListStart(
  userId: string, sheetId: string, statusColumn: string, plan: DestPlan, config: EnrichRunConfig,
): { destSheetId: string } | { raced: string; field?: 'destName' } {
  const dest = applyListDest(userId, sheetId, plan);
  if ('raced' in dest) return dest;
  const list = listOf(config)!;
  list.destSheetId = dest.sheetId;
  list.fields = plan.fields;
  list.copy = plan.copy;
  if (plan.fields) {
    // Earlier test runs of the column (fields not picked) take these fields.
    const held = fieldlessRuns(sheetId, userId, statusColumn);
    const given = giveFields(userId, held, plan.fields, list.dedupe?.path ?? null);
    if ('fail' in given) return { raced: given.message };
  }
  return { destSheetId: dest.sheetId };
}
