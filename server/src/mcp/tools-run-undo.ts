// undo_run: the cells a finished run wrote go back to what they held before
// it (services/run-undo*.ts; REST GET/POST /v1/{ai,http}-runs/:id/undo and the
// app's column menu do the same). It writes cells, so it needs 'write'; it
// calls nothing outside Cubex and bills nothing.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { UNDO_KEEP_DAYS } from '../lib/constants';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { undoRun } from '../services/run-undo';
import { lastUndoable, undoViewOf, type UndoView } from '../services/run-undo-view';
import { kindOf, type RunTypeArg } from './tools-run-manage';
import { McpAuthCtx, err, missingScope, ok, registerTool } from './tool-helpers';

// The answer, with a message an agent can pass on as it is.
function answer(v: UndoView, dryRun: boolean) {
  const cells = (n: number) => `${n.toLocaleString('en-US')} cell${n === 1 ? '' : 's'}`;
  const message = dryRun ? (v.can_undo
    ? `It can be undone: the cells it wrote in ${v.rows.toLocaleString('en-US')} rows go back to what they held.`
    : v.reason)
    : v.state === 'undoing' ? 'Undoing in the background: call undo_run with dry_run true to see how far it got.'
    : `Undone: ${cells(v.restored)} back as they were before the run`
      + `${v.skipped ? `; ${cells(v.skipped)} changed since stayed as they are` : ''}`
      + `${v.gone ? `; ${cells(v.gone)} were in rows or columns deleted since` : ''}.`;
  return ok({ ...v, message });
}

export function registerRunUndoTool(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'undo_run', {
    description:
      'Undo what a finished run wrote: every cell it filled goes back to the value it held before the run (its '
      + 'output columns, its (Data), status, "Answered by" and step columns; cells that were empty go empty '
      + 'again), and its rows\' out_of_date state goes back with them. It SKIPS any cell changed since the run '
      + 'wrote it (edited by a person or an agent, or written by a newer run) and leaves it as it is; cells in '
      + 'rows or columns deleted since (restored from the trash too) are counted as gone. The answer says how '
      + 'many cells were restored, skipped and gone. Nothing runs again and nothing is billed: what the run cost '
      + 'stays spent. A restored row\'s stored answer is no longer that cell\'s answer and is never reused, so '
      + 'running it again calls (and bills) again, unless reuse finds an older run\'s answer; a skipped cell '
      + 'keeps its answer. Clean, formula and lookup columns reading a restored cell work it out again (free), and no auto-run starts. Rows a list enrichment added to '
      + 'another sheet stay (delete_rows removes them), and so does a column added later from its stored '
      + 'answers. A run still going (pending, running or paused) can\'t be undone: control_run cancel first. '
      + 'Newest first: while a newer run that wrote one of its columns can still be undone, an older run is '
      + `refused (undo that one first). Each run is undone once, for ${UNDO_KEEP_DAYS} days after it started. `
      + 'Pass run_type and run_id (list_runs, get_sheet\'s column details), or sheet_id and column for that '
      + 'column\'s newest run that can still be undone. '
      + 'dry_run true changes nothing: it says whether the run can be undone (can_undo, reason), how many rows '
      + 'it wrote, and for an undo under way or done its state and counts. A big undo answers state undoing '
      + 'and goes on in the background; while it runs the sheet is busy (other changes wait).',
    inputSchema: {
      run_type: z.enum(['ai', 'http', 'enrichment', 'waterfall']).optional(),
      run_id: z.string().optional(),
      sheet_id: z.string().optional().describe('With column: undo that column\'s newest run that can be undone.'),
      column: z.string().optional().describe('A column the run fills (its main column or any of its outputs).'),
      dry_run: z.boolean().optional().describe('true: only say what an undo would do, or how far one got.'),
    },
  }, async ({ run_type, run_id, sheet_id, column, dry_run }: {
    run_type?: RunTypeArg; run_id?: string; sheet_id?: string; column?: string; dry_run?: boolean;
  }) => {
    const denied = missingScope(ctx, dry_run ? 'read' : 'write');
    if (denied) return denied;
    let view: UndoView | null;
    if (run_id !== undefined || run_type !== undefined) {
      if (!run_id || !run_type || sheet_id !== undefined || column !== undefined) {
        return err('Pass run_type and run_id, or sheet_id and column, not both.');
      }
      const kind = kindOf(run_type, run_id, ctx.userId);
      view = kind ? undoViewOf(ctx.userId, kind, run_id) : null;
      if (!view) return err('Run not found. list_runs shows the runs of a sheet.');
    } else {
      if (!sheet_id || !column) return err('Pass run_type and run_id, or sheet_id and column.');
      if (!verifySheetOwnership(sheet_id, ctx.userId)) return err('Sheet not found');
      view = lastUndoable(ctx.userId, sheet_id, column);
      if (!view) return err(`"${column}" has no run that can still be undone (none ran in the last ${UNDO_KEEP_DAYS} `
        + 'days, or every one was undone already, or it is no AI, HTTP API, enrichment or waterfall column).');
    }
    if (dry_run) return answer(view, true);
    const out = await undoRun(ctx.userId, view.run_type, view.run_id);
    return 'fail' in out ? err(out.message) : answer(out.ok, false);
  });
}
