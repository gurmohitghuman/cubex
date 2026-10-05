// Column rename — extracted verbatim from routes/sheets-columns-order.ts so
// the UI route and /api/v1 share one implementation. The cascade set is
// load-bearing: rows.data key, column_order, empty_filter,
// column_filters, http_column_associations, stored HTTP run configs, webhook
// refs — miss one and a rename orphans state.
import { db } from '../lib/db';
import { getSheetColumns, touchSheet } from '../lib/sql-helpers';
import { withSheetBusy } from '../lib/sheet-busy';
import { copyColumnKey, recordPurge, forgetPurge, purgeColumnKey } from '../lib/column-purge';
import {
  sanitizeAndValidateColumnName, findColumnNameCollision, columnCollisionMessage,
} from '../lib/column-names';
import { renameWebhookColumnRefs } from '../lib/webhook-columns';
import { renameHttpRunColumnRefs } from '../lib/http-columns';
import { renameAiRunColumnRefs, activeStructuredRunOwnsColumn } from '../lib/ai-columns';
import { activeRunInputError } from '../lib/ai-prompt-inputs';

export type ColumnRenameOutcome =
  | { ok: true; newName: string; noop?: boolean }
  | { fail: 'column_not_found' }
  | { fail: 'invalid'; error: string }
  | { fail: 'collision'; error: string }
  | { fail: 'active_run' | 'busy'; error: string };

// Caller has already verified sheet ownership and that rawNewName is a
// non-empty string. opts.bumpDataVersion: v1 signals open tabs via the change
// poll; the UI route keeps its historical touch-only behavior.
export async function renameSheetColumn(
  sheetId: string,
  userId: string,
  columnName: string,
  rawNewName: string,
  opts: { bumpDataVersion?: boolean } = {},
): Promise<ColumnRenameOutcome> {
  // Same canonical form the cell-PUT / CSV / HTTP write paths use (so a rename
  // to "First  Name" stores "First Name" and later edits hit the same key).
  const v = sanitizeAndValidateColumnName(rawNewName);
  if ('error' in v) return { fail: 'invalid', error: v.error };
  const trimmedNew = v.name;

  const allCols = getSheetColumns(sheetId, userId);
  if (!allCols.includes(columnName)) return { fail: 'column_not_found' };

  // Renaming to the same name is a no-op; let it succeed cleanly so API
  // consumers don't have to special-case it client-side.
  if (trimmedNew === columnName) return { ok: true, newName: trimmedNew, noop: true };

  // Reject exact / case / normalized-token collisions (excluding the column
  // being renamed) — coexistence makes /columnRef resolution non-deterministic.
  const collision = findColumnNameCollision(trimmedNew, allCols, { exclude: columnName });
  if (collision) return { fail: 'collision', error: columnCollisionMessage(trimmedNew, collision) };

  // Block rename while an AI or HTTP run that touches this column is active —
  // both runners cache column names at run start and would write to a name
  // that no longer exists.
  // Also cover the "(Data)" web-search companion: ai_runs.column_name is the
  // "(Output)" name, so a plain match misses "Foo (Data)" while a running
  // web-search run still writes it (mirrors column-delete's guard).
  const dataSiblingOutput = columnName.endsWith(' (Data)')
    ? `${columnName.slice(0, -' (Data)'.length)} (Output)`
    : null;
  const activeAIRun = db.prepare(`
    SELECT id FROM ai_runs
    WHERE sheet_id = ? AND user_id = ?
      -- A run whose leftover ⏳ cells are still being cleared (migration 004)
      -- counts too: a rename would copy them to a name the clear never visits.
      AND (status IN ('pending', 'running', 'paused') OR placeholder_work IS NOT NULL)
      AND (column_name = ? OR (column_name = ? AND use_openrouter_web_search = 1))
    LIMIT 1
  `).get(sheetId, userId, columnName, dataSiblingOutput ?? ' none');
  if (activeAIRun) {
    return { fail: 'active_run', error: 'Cannot rename a column while an AI run on it is active or still clearing its cells. Stop the run, or wait a moment if it was just stopped.' };
  }
  // A structured run's OUTPUT columns live in output_columns, not column_name
  // (which holds its STATUS column), so the check above misses them. Without
  // this, renaming an output column mid-run succeeds: the stored spec is
  // rewritten but the worker already captured the run row (ai-runner.ts), so it
  // keeps writing to the OLD name — recreating a ghost column outside
  // column_order while the renamed column sits on '⏳ Processing...' forever
  // (hasUnfinishedRow only inspects the status column, so the run still
  // finalizes 'completed'). column-delete.ts has always had this guard.
  if (activeStructuredRunOwnsColumn(sheetId, userId, columnName)) {
    return { fail: 'active_run', error: 'Cannot rename a column while a structured AI run on it is active or still clearing its cells. Stop the run, or wait a moment if it was just stopped.' };
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
    return { fail: 'active_run', error: 'Cannot rename a column while an HTTP run on it is active or still clearing its cells. Stop the run, or wait a moment if it was just stopped.' };
  }
  const inputRunError = activeRunInputError(sheetId, userId, columnName, 'rename');
  if (inputRunError) return { fail: 'active_run', error: inputRunError };

  // A big sheet renames without ever showing a half-renamed column: (1) every
  // row gets its value under the new name too, while the sheet still lists the
  // old one; (2) one transaction switches the list and every by-name reference;
  // (3) the old keys, now unlisted, are stripped. Steps 1 and 3 run in slices
  // between requests, and the sheet is busy throughout (lib/sheet-busy.ts). A
  // restart mid-way finishes the strip (lib/column-purge.ts): the partial
  // copies before the switch, the old keys after it.
  const outcome = await withSheetBusy(sheetId, 'renaming a column', async () => {
    recordPurge(sheetId, userId, trimmedNew);
    await copyColumnKey(sheetId, userId, columnName, trimmedNew);
    db.transaction(() => {
      switchColumnName(sheetId, userId, columnName, trimmedNew);
      if (opts.bumpDataVersion) {
        db.prepare(
          `UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
        ).run(sheetId, userId);
      } else {
        touchSheet(sheetId, userId);
      }
      forgetPurge(sheetId, trimmedNew);
      recordPurge(sheetId, userId, columnName);
    })();
    await purgeColumnKey(sheetId, userId, columnName);
    return { ok: true as const, newName: trimmedNew };
  });
  return 'busy' in outcome ? { fail: 'busy', error: outcome.busy } : outcome;
}

// The switch, in one transaction: the column list, both filters, and every
// table that refers to a column by name (miss one and a rename orphans
// state).
function switchColumnName(sheetId: string, userId: string, columnName: string, trimmedNew: string): void {
  const meta = db.prepare(
    'SELECT column_order, empty_filter, column_filters FROM sheets WHERE id = ? AND user_id = ?',
  ).get(sheetId, userId) as {
    column_order: string | null; empty_filter: string | null; column_filters: string | null;
  } | undefined;

  if (meta?.column_order) {
    try {
      const stored = JSON.parse(meta.column_order) as string[];
      db.prepare('UPDATE sheets SET column_order = ? WHERE id = ? AND user_id = ?')
        .run(JSON.stringify(stored.map(c => (c === columnName ? trimmedNew : c))), sheetId, userId);
    } catch { /* malformed — getSheetColumns re-seeds it from the rows */ }
  }

  // Both filters are keyed by column name. Left pointing at the old name, a
  // 'not_empty' filter matches NO rows (the renamed column reads as empty),
  // hiding the whole sheet with no header menu left to clear it.
  for (const field of ['empty_filter', 'column_filters'] as const) {
    const raw = meta?.[field];
    if (!raw) continue;
    try {
      const stored = JSON.parse(raw) as Record<string, unknown>;
      if (!(columnName in stored)) continue;
      stored[trimmedNew] = stored[columnName];
      delete stored[columnName];
      db.prepare(`UPDATE sheets SET ${field} = ? WHERE id = ? AND user_id = ?`)
        .run(JSON.stringify(stored), sheetId, userId);
    } catch { /* malformed — leave it */ }
  }

  // http_column_associations hold column names as plain strings.
  db.prepare(
    `UPDATE http_column_associations SET master_column_name = ?
     WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?`,
  ).run(trimmedNew, sheetId, userId, columnName);
  db.prepare(
    `UPDATE http_column_associations SET extracted_column_name = ?
     WHERE sheet_id = ? AND user_id = ? AND extracted_column_name = ?`,
  ).run(trimmedNew, sheetId, userId, columnName);
  // ai_runs: column_name, status_column, output_columns JSON and the "(Data)"
  // companion flag (see ai-columns.ts).
  renameAiRunColumnRefs(sheetId, userId, columnName, trimmedNew);
  // The STORED HTTP run config (master_column_name, responseMapping[].columnName):
  // a rerun reads it to decide where the worker writes results.
  renameHttpRunColumnRefs(sheetId, userId, columnName, trimmedNew);
  // Webhook mappings and the raw marker name.
  renameWebhookColumnRefs(sheetId, userId, columnName, trimmedNew);
}
