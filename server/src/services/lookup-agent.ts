// lookup_column for agents: MCP and POST /api/v1/sheets/:id/lookup-columns
// call this one function. preview reads only. Otherwise the column is created
// (or, naming a lookup column already there, changed) and the answer waits for
// the fill up to LOOKUP_WAIT_MS, so most sheets answer with their counts; a
// bigger one answers "filling" (get_sheet lists it in filling_columns until done).
import { LOOKUP_WAIT_MS } from '../lib/constants';
import { strayKey } from '../lib/enrich-agent-args';
import { flagOf } from '../lib/enrich-agent-input';
import { waitForDerivedFill } from './derived-fill';
import { startLookupColumn, type LookupColumnInput } from './lookup-column';
import { lookupKind } from './lookup-kind';
import { previewLookupColumn } from './lookup-preview';
import { lookupColumnJson, lookupColumnView } from './lookup-view';
import type { RunFail } from './run-shared';

export interface AgentLookupArgs {
  column?: unknown; source_column?: unknown; other_sheet_id?: unknown; match_column?: unknown; match?: unknown;
  returns?: unknown; return_column?: unknown; return_columns?: unknown; limit?: unknown; auto_run?: unknown;
  preview?: unknown;
}
const KNOWN = ['column', 'source_column', 'other_sheet_id', 'match_column', 'match', 'returns', 'return_column',
  'return_columns', 'limit', 'auto_run', 'preview'];

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const FILLING_NOTE = 'Still filling: its cells read "⏳ Processing..." until done. '
  + 'get_sheet lists it in filling_columns. Contains on very large sheets can take minutes.';

export type AgentLookupOutcome = { ok: Record<string, unknown>; created: boolean } | RunFail;

export async function agentLookupColumn(
  userId: string, sheetId: string, a: AgentLookupArgs,
): Promise<AgentLookupOutcome> {
  const stray = strayKey(a as Record<string, unknown>, KNOWN, '');
  if (stray) return bad(`${stray} Nothing was changed.`);
  const preview = flagOf(a.preview), autoRun = flagOf(a.auto_run);
  if (preview === 'invalid' || autoRun === 'invalid') return bad('preview and auto_run must be true or false.');
  const input: LookupColumnInput = {
    column: a.column, sourceColumn: a.source_column, otherSheetId: a.other_sheet_id, matchColumn: a.match_column,
    match: a.match, returns: a.returns, returnColumn: a.return_column, returnColumns: a.return_columns,
    limit: a.limit, autoRun,
  };
  if (preview) {
    const p = previewLookupColumn(userId, sheetId, input);
    if ('fail' in p) return p;
    return {
      created: false,
      ok: {
        preview: true, column: p.ok.column, changes_existing_column: p.ok.existing, other_sheet: p.ok.otherSheet,
        other_rows: p.ok.otherRows,
        ...(p.ok.checkedRows === null ? {} : {
          checked_rows: p.ok.checkedRows,
          checked_note: `The preview read the first ${p.ok.checkedRows} rows of "${p.ok.otherSheet}"; `
            + 'the lookup itself reads every row.',
        }),
        samples: p.ok.samples.map(s => ({
          row_index: s.row, value: s.value, result: s.result, ...(s.error ? { error: s.error } : {}),
        })),
        note: 'Nothing was written. Call again without preview to create the column.',
      },
    };
  }
  const started = await startLookupColumn(userId, sheetId, input);
  if ('fail' in started) return started;
  const rec = await waitForDerivedFill(lookupKind, started.ok.id, LOOKUP_WAIT_MS);
  if (!rec) return { fail: 'conflict', message: 'The lookup column was removed while it filled.' };
  return {
    created: started.ok.created,
    ok: {
      ...lookupColumnJson(lookupColumnView(rec)), created: started.ok.created,
      ...(rec.fill_status === 'filling' ? { note: FILLING_NOTE } : {}),
    },
  };
}
