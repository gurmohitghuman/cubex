// Over 200 lines: one call's whole life (its items, working table, start, results and sweep) in one place.
// A saved setup called like a function on 1-SETUP_CALL_MAX_ITEMS items, without a sheet: one implementation for
// /api/v1 (routes/api-v1-setup-calls.ts) and MCP (mcp/tools-setup-calls.ts). The items become the rows of a hidden
// working table (tables.hidden, migration 067: never listed or counted), one column per setup input, and the setup
// runs there through applySetup, as on any sheet: its estimate and ceiling, its step runs, pause, resume and stop
// (control_setup_run), the run-finished webhook (kind "setup"). The call's id is the setup run's, so polling and
// the webhook name one id. An estimate, or a start refused, removes the working table at once; a started call's
// table goes SETUP_CALL_KEEP_HOURS after it finishes (the sweep below), its results with it. Auto-run is never
// turned on there (ApplyInput.call). The working table goes through the trash, purged at once and never listed.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import {
  SETUP_CALL_KEEP_HOURS, SETUP_CALL_MAX_ITEMS, SETUP_CALL_ORPHAN_HOURS, SETUP_CALL_SWEEP_MS,
} from '../lib/constants-setups';
import { stepColumns, type SetupSpec } from '../lib/setups/spec';
import { callItem, type SetupCallItem } from '../lib/setups/call-item';
import type { RateDecision } from '../lib/rate-window';
import { startRefusalMessage, takeRunStart } from './run-shared';
import { withoutChangeLog } from '../lib/change-log';
import { getSetup } from './setup-library';
import { applySetup, type ApplyFail, type ApplyInput } from './setup-apply';
import { getSetupRun, loadSetupRun, type SetupRunView } from './setup-run-store';
import { createTable } from './table-crud';
import { addSheetColumn } from './column-add';
import { appendRows } from './rows-write';
import { parseCellMap, txnFailMessage } from './data-plane-shared';
import { trashTable } from './trash-sheets';
import { purgeTrashItems } from './trash-purge';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';

// What a call takes besides its items: apply_setup's choices that make sense without a sheet.
export type CallInput = Pick<ApplyInput, 'models' | 'estimateOnly' | 'webhookId' | 'maxCostUsd' | 'allowUnpriced'>;

export type { SetupCallItem } from '../lib/setups/call-item';
export interface SetupCallView {
  id: string; setup_id: string | null; setup_name: string; status: SetupRunView['status']; items: number;
  layer: number; layers: number; error_message: string | null; created_at: string; updated_at: string;
  // When the results go (null while it runs): SETUP_CALL_KEEP_HOURS after it finished.
  keep_until: string | null;
  webhook_id: string | null; max_cost_usd?: number;
  steps: Array<Pick<SetupRunView['steps'][number], 'column' | 'kind' | 'layer' | 'state' | 'run_id' | 'note'>>;
  // Once it has finished (done, failed or cancelled): each item, in the order sent.
  results?: SetupCallItem[];
}

// rate_limited: the token's run-start window is full (rate: for REST's Retry-After).
export type CallFail = Omit<ApplyFail, 'fail'> & { fail: ApplyFail['fail'] | 'rate_limited'; rate?: RateDecision };
export type CallOutcome =
  | { ok: { estimate: object; makes: string[]; items: number } }
  | { ok: { setup_call: SetupCallView } }
  | CallFail;

const bad = (message: string): ApplyFail => ({ fail: 'bad_request', message });
export const CALL_NOT_FOUND =
  `Setup call not found: results are kept ${SETUP_CALL_KEEP_HOURS} hours after a call finishes.`;
const FINISHED = new Set(['done', 'failed', 'cancelled']);

// The items, checked: an array of 1 to SETUP_CALL_MAX_ITEMS objects keyed by the setup's input names, each value a
// string, number, boolean or null (a cell). An item may leave inputs out (they read as empty).
function itemsOf(raw: unknown, inputs: string[]): Array<Record<string, string>> | string {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SETUP_CALL_MAX_ITEMS) {
    return `items must be an array of 1 to ${SETUP_CALL_MAX_ITEMS} objects, each keyed by the setup's inputs`
      + (inputs.length ? ` (${inputs.map(n => `"${n}"`).join(', ')})` : '') + '.';
  }
  const known = new Set(inputs);
  const out: Array<Record<string, string>> = [];
  for (const [i, item] of raw.entries()) {
    if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0) {
      out.push(Object.create(null) as Record<string, string>);
      continue;
    }
    const parsed = parseCellMap(item, Math.max(1, inputs.length));
    if ('error' in parsed) return `Item ${i}: ${parsed.error}.`;
    const unknown = Object.keys(parsed.cells).find(k => !known.has(k));
    if (unknown !== undefined) {
      return `Item ${i} has "${unknown.slice(0, 50)}", which isn't an input of this setup`
        + (inputs.length ? ` (its inputs: ${inputs.map(n => `"${n}"`).join(', ')}).` : ' (it has none).');
    }
    out.push(parsed.cells);
  }
  return out;
}

// Deletes a working table: into the trash (its runs stop) and purged from there at once, in slices.
export function removeWorkingTable(userId: string, tableId: string): void {
  const out = trashTable(userId, tableId);
  if ('ok' in out && out.ok.trashId !== null) purgeTrashItems(userId, [out.ok.trashId]);
}

// The hidden working table with one column per setup input and one row per item, in the order sent.
function workingTable(userId: string, spec: SetupSpec, items: Array<Record<string, string>>):
  { tableId: string; sheetId: string } | ApplyFail {
  const made = withoutChangeLog(() => createTable(userId, `Setup call ${uuidv4()}`, { hidden: true }));
  if ('fail' in made) return { fail: 'bad_request', message: made.message };
  const { id: tableId, sheetId } = made.ok;
  const fail = (message: string): ApplyFail => {
    removeWorkingTable(userId, tableId);
    return { fail: 'bad_request', message };
  };
  for (const name of spec.inputs) {
    const added = withoutChangeLog(() => addSheetColumn(sheetId, userId, name, { seedEmptyRow: false }));
    if ('fail' in added) return fail(added.error);
  }
  const appended = withoutChangeLog(() => appendRows(sheetId, userId, items));
  if ('fail' in appended) return fail(txnFailMessage(appended, MAX_ROWS_PER_SHEET));
  return { tableId, sheetId };
}

// A start takes a slot of the access token's run-start window, as a column run's start does (run-shared.ts); a
// token at its spend cap is refused first, unless every step is free.
function startSlot(userId: string, tokenId: string, spec: SetupSpec): CallFail | null {
  const paid = spec.steps.some(s => s.kind === 'ai' || s.kind === 'enrichment');
  const refused = takeRunStart(userId, tokenId, paid);
  if (!refused) return null;
  return 'capped' in refused ? { fail: 'forbidden', message: refused.capped }
    : { fail: 'rate_limited', message: startRefusalMessage(refused), rate: refused.limited };
}

export async function callSetup(
  userId: string, setupId: string, rawItems: unknown, input: CallInput,
  caller: { hasSecretsScope: boolean; tokenId?: string | null },
): Promise<CallOutcome> {
  const setup = getSetup(userId, setupId);
  if (!setup) return { fail: 'not_found', message: 'Setup not found' };
  const items = itemsOf(rawItems, setup.spec.inputs);
  if (typeof items === 'string') return bad(items);
  const slot = !input.estimateOnly && caller.tokenId ? startSlot(userId, caller.tokenId, setup.spec) : null;
  if (slot) return slot;
  const work = workingTable(userId, setup.spec, items);
  if ('fail' in work) return work;
  const { tableId, sheetId } = work;
  let started = false;
  try {
    const out = await applySetup(userId, sheetId, setupId, {
      models: input.models, estimateOnly: input.estimateOnly, webhookId: input.webhookId ?? null,
      maxCostUsd: input.maxCostUsd ?? null, allowUnpriced: input.allowUnpriced, firstRows: null, call: true,
    }, caller);
    if ('fail' in out) return out;
    if ('estimate' in out.ok) return { ok: { estimate: out.ok.estimate, makes: out.ok.makes, items: items.length } };
    const runId = out.ok.setup_run.id;
    db.prepare('INSERT INTO setup_calls (id, user_id, table_id, sheet_id, items) VALUES (?, ?, ?, ?, ?)')
      .run(runId, userId, tableId, sheetId, items.length);
    started = true;
    return { ok: { setup_call: getSetupCall(userId, runId)! } };
  } finally {
    if (!started) removeWorkingTable(userId, tableId);
  }
}

// SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) plus hours, as ISO.
const plusHours = (at: string, hours: number): string =>
  new Date(Date.parse(`${at.replace(' ', 'T')}Z`) + hours * 3_600_000).toISOString();

// Each item's status and outputs: every column the setup's steps make, read from the working table's rows in order.
function resultsOf(userId: string, sheetId: string, spec: SetupSpec): SetupCallItem[] {
  const columns = [...new Set(spec.steps.flatMap(stepColumns))];
  const rows = db.prepare('SELECT data FROM rows WHERE sheet_id = ? AND user_id = ? ORDER BY row_index LIMIT ?')
    .pluck().all(sheetId, userId, SETUP_CALL_MAX_ITEMS) as string[];
  return rows.map((data, item) => {
    let cells: Record<string, unknown> = {};
    try { cells = JSON.parse(data) as Record<string, unknown>; } catch { /* an unreadable row reads as empty */ }
    return callItem(item, cells, columns);
  });
}

export function getSetupCall(userId: string, id: string): SetupCallView | null {
  const call = db.prepare('SELECT sheet_id, items FROM setup_calls WHERE id = ? AND user_id = ?').get(id, userId) as
    { sheet_id: string; items: number } | undefined;
  const run = call && getSetupRun(userId, id);
  if (!call || !run) return null;
  const finished = FINISHED.has(run.status);
  const plan = JSON.parse(loadSetupRun(id)!.plan) as { spec: SetupSpec };
  return {
    id, setup_id: run.setup_id, setup_name: run.setup_name, status: run.status, items: call.items,
    layer: run.layer, layers: run.layers, error_message: run.error_message, created_at: run.created_at,
    updated_at: run.updated_at,
    keep_until: finished ? plusHours(loadSetupRun(id)!.updated_at, SETUP_CALL_KEEP_HOURS) : null,
    webhook_id: run.webhook_id, ...(run.max_cost_usd !== undefined ? { max_cost_usd: run.max_cost_usd } : {}),
    steps: run.steps.map(s => ({ column: s.column, kind: s.kind, layer: s.layer, state: s.state, run_id: s.run_id,
      note: s.note })),
    ...(finished ? { results: resultsOf(userId, call.sheet_id, plan.spec) } : {}),
  };
}

// The sweep: the working tables of calls finished SETUP_CALL_KEEP_HOURS ago, and of calls that never started (a
// restart between the table and the run) SETUP_CALL_ORPHAN_HOURS after they were made.
export function sweepSetupCalls(): number {
  const due = db.prepare(`SELECT c.user_id, c.table_id FROM setup_calls c JOIN setup_runs r ON r.id = c.id
      WHERE r.status IN ('done', 'failed', 'cancelled') AND r.updated_at <= datetime('now', ?)
    UNION ALL
    SELECT t.user_id, t.id FROM tables t WHERE t.hidden = 1 AND t.trash_id IS NULL
      AND t.created_at <= datetime('now', ?) AND NOT EXISTS (SELECT 1 FROM setup_calls c WHERE c.table_id = t.id)`)
    .all(`-${SETUP_CALL_KEEP_HOURS} hours`, `-${SETUP_CALL_ORPHAN_HOURS} hours`) as
    Array<{ user_id: string; table_id: string }>;
  for (const d of due) {
    try { removeWorkingTable(d.user_id, d.table_id); } catch (err) {
      console.error(`A setup call's working table ${d.table_id} couldn't be removed (tried again next sweep):`, err);
    }
  }
  return due.length;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startSetupCallLoop(): void {
  if (timer) return;
  timer = setInterval(() => { sweepSetupCalls(); }, SETUP_CALL_SWEEP_MS);
  timer.unref?.();
}
