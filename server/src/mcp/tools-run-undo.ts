// control_run's undo (undo_run before v0.8.47): the cells a finished run wrote go back to what they held before
// it (services/run-undo*.ts; REST GET/POST /v1/{ai,http}-runs/:id/undo and the app's column menu do the same).
// It writes cells, so it needs 'write' (a dry run 'read'); it calls nothing outside Cubex and bills nothing.
import { UNDO_KEEP_DAYS } from '../lib/constants';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { undoRun } from '../services/run-undo';
import { journalColumns, journalOf, lastUndoable, undoViewOf, type UndoView } from '../services/run-undo-view';
import { kindOf, type RunTypeArg } from './run-kind';
import { McpAuthCtx, err, missingScope, ok } from './tool-helpers';
import { changedOf, type Changed } from './changed';

// The answer, with a message an agent can pass on as it is.
function answer(v: UndoView, dryRun: boolean, changed: Changed[] = []) {
  const cells = (n: number) => `${n.toLocaleString('en-US')} cell${n === 1 ? '' : 's'}`;
  const message = dryRun ? (v.can_undo
    ? `It can be undone: the cells it wrote in ${v.rows.toLocaleString('en-US')} rows go back to what they held.`
    : v.reason ?? 'It can\'t be undone.')
    : v.state === 'undoing'
      ? 'Undoing in the background: call control_run with action undo and dry_run true to see how far it got.'
    : `Undone: ${cells(v.restored)} back as they were before the run`
      + `${v.skipped ? `; ${cells(v.skipped)} changed since stayed as they are` : ''}`
      + `${v.gone ? `; ${cells(v.gone)} were in rows or columns deleted since` : ''}.`;
  return ok({ ...v, message, changed });
}

// A run by run_type and run_id, or a column's newest run that can still be undone by sheet_id and column.
export async function undoAction(ctx: McpAuthCtx, a: {
  run_type?: RunTypeArg; run_id?: string; sheet_id?: string; column?: string; dry_run?: boolean;
}) {
  const { run_type, run_id, sheet_id, column, dry_run } = a;
  const denied = missingScope(ctx, dry_run ? 'read' : 'write');
  if (denied) return denied;
  let view: UndoView | null;
  if (run_id !== undefined || run_type !== undefined) {
    if (!run_id || !run_type || sheet_id !== undefined || column !== undefined) {
      return err('Pass run_type and run_id, or sheet_id and column, not both.');
    }
    const kind = kindOf(run_type, run_id, ctx.userId);
    view = kind ? undoViewOf(ctx.userId, kind, run_id) : null;
    if (!view) return err('Run not found. get_run (action list) shows the runs of a sheet.');
  } else {
    if (!sheet_id || !column) return err('Pass run_type and run_id, or sheet_id and column.');
    if (!verifySheetOwnership(sheet_id, ctx.userId)) return err('Sheet not found');
    view = lastUndoable(ctx.userId, sheet_id, column);
    if (!view) return err(`"${column}" has no run that can still be undone (none ran in the last ${UNDO_KEEP_DAYS} `
      + 'days, or every one was undone already, or it is no AI, HTTP API, enrichment or waterfall column).');
  }
  if (dry_run) return answer(view, true);
  const out = await undoRun(ctx.userId, view.run_type, view.run_id);
  if ('fail' in out) return err(out.message);
  // Every column the run wrote goes back, its outputs too (a deleted one isn't named).
  const j = journalOf(out.ok.run_type, out.ok.run_id, ctx.userId);
  const columns = (j ? journalColumns(j) : [out.ok.column]).filter((c): c is string => c !== null);
  return answer(out.ok, false, changedOf(ctx.userId, [{ sheetId: out.ok.sheet_id, columns, rows: out.ok.rows,
    moreComing: out.ok.state === 'undoing' }]));
}
