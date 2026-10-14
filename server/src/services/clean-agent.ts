// clean_column for agents: MCP and POST /api/v1/sheets/:id/clean-columns call
// this one function. preview reads only. Otherwise the column is created (or,
// naming a clean column already there, changed) and the answer waits for the
// fill up to CLEAN_WAIT_MS, so most sheets answer with their counts; a bigger
// one answers "filling" (get_sheet lists it in filling_columns until done).
import { CLEAN_WAIT_MS } from '../lib/constants';
import { strayKey } from '../lib/enrich-agent-args';
import { flagOf } from '../lib/enrich-agent-input';
import { startCleanColumn, type CleanColumnInput } from './clean-column';
import { previewCleanColumn } from './clean-preview';
import { waitForCleanFill } from './clean-fill';
import { cleanColumnJson, cleanColumnView } from './clean-view';
import type { RunFail } from './run-shared';

export interface AgentCleanArgs {
  source_column?: unknown; cleaner?: unknown; column?: unknown; phone_format?: unknown; phone_country?: unknown;
  auto_run?: unknown; preview?: unknown;
}
const KNOWN = ['source_column', 'cleaner', 'column', 'phone_format', 'phone_country', 'auto_run', 'preview'];

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const FILLING_NOTE = 'Still filling: its cells read "⏳ Processing..." until done. '
  + 'get_sheet lists it in filling_columns.';

export type AgentCleanOutcome = { ok: Record<string, unknown>; created: boolean } | RunFail;

export async function agentCleanColumn(userId: string, sheetId: string, a: AgentCleanArgs): Promise<AgentCleanOutcome> {
  const stray = strayKey(a as Record<string, unknown>, KNOWN, '');
  if (stray) return bad(`${stray} Nothing was changed.`);
  const preview = flagOf(a.preview), autoRun = flagOf(a.auto_run);
  if (preview === 'invalid' || autoRun === 'invalid') return bad('preview and auto_run must be true or false.');
  const input: CleanColumnInput = {
    source: a.source_column, cleaner: a.cleaner, column: a.column,
    options: { phoneFormat: a.phone_format ?? null, phoneCountry: a.phone_country ?? null },
    autoRun,
  };
  if (preview) {
    const p = previewCleanColumn(userId, sheetId, input);
    if ('fail' in p) return p;
    return {
      created: false,
      ok: {
        preview: true, column: p.ok.column, cleans_existing_column: p.ok.existing,
        samples: p.ok.samples.map(s => ({ row_index: s.row, before: s.before, after: s.after })),
        note: 'Nothing was written. Call again without preview to create the column.',
      },
    };
  }
  const started = await startCleanColumn(userId, sheetId, input);
  if ('fail' in started) return started;
  const rec = await waitForCleanFill(started.ok.id, CLEAN_WAIT_MS);
  if (!rec) return { fail: 'conflict', message: 'The clean column was removed while it filled.' };
  const view = cleanColumnJson(cleanColumnView(rec));
  return {
    created: started.ok.created,
    ok: {
      ...view, created: started.ok.created,
      ...(rec.fill_status === 'filling' ? { note: FILLING_NOTE } : {}),
    },
  };
}
