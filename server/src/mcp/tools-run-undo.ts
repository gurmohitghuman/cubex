// undo_run: the cells a finished run wrote go back to what they held before
// it (services/run-undo*.ts; REST GET/POST /v1/{ai,http}-runs/:id/undo and the
// app's column menu do the same). It writes cells, so it needs 'write'; it
// calls nothing outside Cubex and bills nothing.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
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
      'Undo what a finished run wrote: each cell it filled gets back what it held before (its outputs, (Data), '
      + 'status, "Answered by" and step columns), and so does its rows\' out_of_date state. Use it when a run '
      + 'wrote wrong answers; to fill rows again instead, control_run rerun. It SKIPS a cell changed since (by a '
      + 'person, an agent or a newer run); cells in rows or columns deleted since count as gone. Nothing runs '
      + 'again and nothing is refunded. A restored cell\'s stored answer is never reused, so running it again '
      + 'bills again. Clean, formula and lookup columns reading a restored cell work it out again (free); no '
      + 'auto-run starts. Rows a list enrichment added to another sheet stay (delete_rows removes them). A run '
      + 'still going can\'t be undone (control_run cancel first). Newest first: while a newer run that wrote one '
      + `of its columns can be undone, an older one is refused. Each run once, for ${UNDO_KEEP_DAYS} days after it `
      + 'started. Pass run_type and run_id (list_runs, get_sheet\'s column_details), or sheet_id and column for '
      + 'that column\'s newest run. Returns state and how many cells were restored, skipped and gone; a big undo '
      + 'answers state undoing and goes on in the background (the sheet is busy meanwhile: call again with '
      + 'dry_run true to see how far it got).',
    inputSchema: {
      run_type: z.enum(['ai', 'http', 'enrichment', 'waterfall']).optional().describe('With run_id: the run\'s kind'),
      run_id: z.string().optional().describe('The run to undo (list_runs)'),
      sheet_id: z.string().optional().describe('With column: undo that column\'s newest run that can be undone.'),
      column: z.string().optional().describe('A column the run fills (its main column or any of its outputs).'),
      dry_run: z.boolean().optional()
        .describe('true: change nothing; say whether it can be undone (can_undo, reason) or how far one got'),
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
