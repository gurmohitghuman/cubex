// Column delete — extracted verbatim from routes/sheets-columns-delete.ts so
// the UI route and /api/v1 share one implementation. Cascades: rows.data key,
// column_order, empty_filter, column_filters,
// http_column_associations, stored HTTP run configs, webhook mappings; guards:
// active-run 409, webhook raw-marker protection, last-column.
import { db } from '../lib/db';
import { getSheetColumns, touchSheet } from '../lib/sql-helpers';
import { withSheetBusy } from '../lib/sheet-busy';
import { recordPurge, purgeColumnKey } from '../lib/column-purge';
import { isWebhookRawColumn, deleteWebhookMappingsForColumn } from '../lib/webhook-columns';
import { deleteHttpRunColumnRefs } from '../lib/http-columns';
import { deleteAiRunColumnRefs, activeStructuredRunOwnsColumn } from '../lib/ai-columns';
import { activeRunInputError } from '../lib/ai-prompt-inputs';

export type ColumnDeleteOutcome =
  | { ok: true }
  | { fail: 'column_not_found' }
  | { fail: 'active_run' | 'busy'; error: string }
  | { fail: 'webhook_column'; error: string }
  | { fail: 'last_column'; error: string };

// Caller has already verified sheet ownership. opts.bumpDataVersion: v1
// signals open tabs via the change poll; the UI route keeps touch-only.
export async function deleteSheetColumn(
  sheetId: string,
  userId: string,
  columnName: string,
  opts: { bumpDataVersion?: boolean } = {},
): Promise<ColumnDeleteOutcome> {
  // Without this check, deleting a missing column json_remove's a missing key
  // (no-op) and we'd report success with zero effect.
  const allCols = getSheetColumns(sheetId, userId);
  if (!allCols.includes(columnName)) return { fail: 'column_not_found' };

  // Block delete while an AI/HTTP run targeting this column is active — an
  // in-flight runner would write to a column that no longer exists. This must
  // also cover the "(Data)" web-search companion: ai_runs.column_name is the
  // "(Output)" name, so a plain column_name match misses "Foo (Data)"; a
  // running web-search run (use_openrouter_web_search=1) still writes it. Derive
  // the sibling (Output) name and check that too.
  const dataSiblingOutput = columnName.endsWith(' (Data)')
    ? `${columnName.slice(0, -' (Data)'.length)} (Output)`
    : null;
  const activeAIRun = db.prepare(`
    SELECT id FROM ai_runs
    WHERE sheet_id = ? AND user_id = ?
      -- A stopped run still clearing its ⏳ cells (migration 004) counts too:
      -- its clear would wipe a new run's placeholders under the same name.
      AND (status IN ('pending', 'running', 'paused') OR placeholder_work IS NOT NULL)
      AND (column_name = ? OR data_column = ? OR (column_name = ? AND use_openrouter_web_search = 1))
    LIMIT 1
  `).get(sheetId, userId, columnName, columnName, dataSiblingOutput ?? ' __no_sibling__');
  if (activeAIRun) {
    return { fail: 'active_run', error: 'Cannot delete a column while an AI run on it is active or still clearing its cells. Stop the run, or wait a moment if it was just stopped.' };
  }
  // A structured run's OUTPUT columns live in output_columns, not column_name, so
  // the check above (which matches column_name = the status column) misses them.
  if (activeStructuredRunOwnsColumn(sheetId, userId, columnName)) {
    return { fail: 'active_run', error: 'Cannot delete a column while a structured AI run on it is active or still clearing its cells. Stop the run, or wait a moment if it was just stopped.' };
  }
  const activeHTTPRun = db.prepare(`
    SELECT 1 FROM http_runs hr
    WHERE hr.sheet_id = ? AND hr.user_id = ?
      AND (hr.status IN ('pending', 'running', 'paused') OR hr.placeholder_work IS NOT NULL)
      AND (
        hr.master_column_name = ?
        OR EXISTS (
          SELECT 1 FROM http_column_associations a
          WHERE a.run_id = hr.id AND a.extracted_column_name = ?
        )
      )
    LIMIT 1
  `).get(sheetId, userId, columnName, columnName);
  if (activeHTTPRun) {
    return { fail: 'active_run', error: 'Cannot delete a column while an HTTP run on it is active or still clearing its cells. Stop the run, or wait a moment if it was just stopped.' };
  }
  // Guards above protect a run's OUTPUT columns; this protects its INPUTS.
  const inputRunError = activeRunInputError(sheetId, userId, columnName, 'delete');
  if (inputRunError) return { fail: 'active_run', error: inputRunError };

  // The webhook's raw marker column is protected while the webhook exists —
  // it's how a row points back to the event that created it.
  if (isWebhookRawColumn(sheetId, userId, columnName)) {
    return {
      fail: 'webhook_column',
      error: 'This column belongs to a webhook. Delete the webhook first (Webhook drawer), then the column.',
    };
  }

  if (getSheetColumns(sheetId, userId).length <= 1) {
    return { fail: 'last_column', error: 'Cannot delete the last column in a sheet' };
  }

  const meta = db.prepare(
    'SELECT column_order, empty_filter, column_filters FROM sheets WHERE id = ? AND user_id = ?',
  ).get(sheetId, userId) as {
    column_order: string | null; empty_filter: string | null; column_filters: string | null;
  } | undefined;

  let nextColumnOrder: string | undefined;
  if (meta?.column_order) {
    try {
      const stored = JSON.parse(meta.column_order) as string[];
      const pruned = stored.filter(c => c !== columnName);
      if (pruned.length !== stored.length) nextColumnOrder = JSON.stringify(pruned);
    } catch { /* malformed JSON — leave it alone */ }
  }

  // empty_filter is keyed by column name. An orphaned 'not_empty' key for a
  // deleted column matches NO rows, hiding the entire sheet — with the
  // column's header menu (the only filter UI) gone.
  let nextEmptyFilter: string | null | undefined;
  if (meta?.empty_filter) {
    try {
      const stored = JSON.parse(meta.empty_filter) as Record<string, string>;
      if (columnName in stored) {
        delete stored[columnName];
        nextEmptyFilter = Object.keys(stored).length === 0 ? null : JSON.stringify(stored);
      }
    } catch { /* malformed JSON — leave it alone */ }
  }

  // column_filters ("text contains") — same orphan hazard as empty_filter.
  let nextColumnFilters: string | null | undefined;
  if (meta?.column_filters) {
    try {
      const stored = JSON.parse(meta.column_filters) as Record<string, unknown>;
      if (columnName in stored) {
        delete stored[columnName];
        nextColumnFilters = Object.keys(stored).length === 0 ? null : JSON.stringify(stored);
      }
    } catch { /* malformed JSON — leave it alone */ }
  }

  // The column leaves the list (and every by-name reference) in one
  // transaction, so it disappears at once; its values are then stripped from
  // the rows in slices between requests, with the sheet busy (lib/sheet-busy.ts)
  // and the strip recorded so a restart finishes it (lib/column-purge.ts).
  const outcome = await withSheetBusy(sheetId, 'deleting a column', async () => {
    db.transaction(() => {
      recordPurge(sheetId, userId, columnName);
      // http_column_associations references columns by name string (not FK), so
      // DELETE CASCADE doesn't cover us.
      db.prepare(
        `DELETE FROM http_column_associations
         WHERE sheet_id = ? AND user_id = ? AND (master_column_name = ? OR extracted_column_name = ?)`,
      ).run(sheetId, userId, columnName, columnName);
      // Disassociate every ai_runs reference to the deleted column — tombstone
      // column_name, clear the "(Data)" companion flag, NULL status_column, prune
      // output_columns (see ai-columns.ts). Prevents a NEW plain column reusing the
      // name from being misclassified as AI output / stale-rerun-overwritten.
      deleteAiRunColumnRefs(sheetId, userId, columnName);
      // Prune the deleted column from any stored HTTP run config's
      // responseMapping so a later rerun doesn't re-create it.
      deleteHttpRunColumnRefs(sheetId, userId, columnName);
      // Drop any webhook mapping that targeted this column (the raw marker is
      // already protected above).
      deleteWebhookMappingsForColumn(sheetId, userId, columnName);
      if (nextColumnOrder !== undefined) {
        db.prepare('UPDATE sheets SET column_order = ? WHERE id = ? AND user_id = ?')
          .run(nextColumnOrder, sheetId, userId);
      }
      if (nextEmptyFilter !== undefined) {
        db.prepare('UPDATE sheets SET empty_filter = ? WHERE id = ? AND user_id = ?')
          .run(nextEmptyFilter, sheetId, userId);
      }
      if (nextColumnFilters !== undefined) {
        db.prepare('UPDATE sheets SET column_filters = ? WHERE id = ? AND user_id = ?')
          .run(nextColumnFilters, sheetId, userId);
      }
      if (opts.bumpDataVersion) {
        db.prepare(
          `UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
        ).run(sheetId, userId);
      } else {
        touchSheet(sheetId, userId);
      }
    })();
    await purgeColumnKey(sheetId, userId, columnName);
    return { ok: true as const };
  });
  return 'busy' in outcome ? { fail: 'busy', error: outcome.busy } : outcome;
}
