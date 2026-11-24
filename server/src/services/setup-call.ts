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
  SETUP_CALL_KEEP_HOURS, SETUP_CALL_MAX_ITEMS, SETUP_CALL_ORPHAN_HOURS,
} from '../lib/constants-setups';
import { sheetBusyWith } from '../lib/sheet-busy';
import type { SetupSpec } from '../lib/setups/spec';
import { withoutChangeLog } from '../lib/change-log';
import { getSetup } from './setup-library';
import { applySetup, type ApplyFail, type ApplyInput } from './setup-apply';
import { getSetupCall, type SetupCallView } from './setup-call-view';
import { createTable } from './table-crud';
import { addSheetColumn } from './column-add';
import { appendRows } from './rows-write';
import { parseCellMap, txnFailMessage } from './data-plane-shared';
import { trashTable } from './trash-sheets';
import { purgeTrashItems } from './trash-purge';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';

// What a call takes besides its items: apply_setup's choices that make sense without a sheet.
export type CallInput = Pick<ApplyInput, 'models' | 'estimateOnly' | 'webhookId' | 'maxCostUsd' | 'allowUnpriced'>;
export { CALL_NOT_FOUND, getSetupCall, type SetupCallView } from './setup-call-view';

export type CallOutcome =
  | { ok: { estimate: object; makes: string[]; items: number } }
  | { ok: { setup_call: SetupCallView } }
  | ApplyFail;

const bad = (message: string): ApplyFail => ({ fail: 'bad_request', message });

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

// A hidden working table with one column per setup input and no rows yet (an upload link's import fills it).
export function newWorkingTable(userId: string, spec: SetupSpec): { tableId: string; sheetId: string } | ApplyFail {
  const made = withoutChangeLog(() => createTable(userId, `Setup call ${uuidv4()}`, { hidden: true }));
  if ('fail' in made) return { fail: 'bad_request', message: made.message };
  const { id: tableId, sheetId } = made.ok;
  for (const name of spec.inputs) {
    const added = withoutChangeLog(() => addSheetColumn(sheetId, userId, name, { seedEmptyRow: false }));
    if ('fail' in added) {
      removeWorkingTable(userId, tableId);
      return bad(added.error);
    }
  }
  return { tableId, sheetId };
}

// The setup applied on a working table that holds its items: priced, or started as a call. Unless it starts, the
// working table is removed.
export async function startCall(
  userId: string, setupId: string, work: { tableId: string; sheetId: string }, input: CallInput,
  caller: { hasSecretsScope: boolean },
): Promise<CallOutcome> {
  const { tableId, sheetId } = work;
  let started = false;
  try {
    const items = db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND user_id = ?').pluck()
      .get(sheetId, userId) as number;
    const out = await applySetup(userId, sheetId, setupId, {
      models: input.models, estimateOnly: input.estimateOnly, webhookId: input.webhookId ?? null,
      maxCostUsd: input.maxCostUsd ?? null, allowUnpriced: input.allowUnpriced, firstRows: null, call: true,
    }, caller);
    if ('fail' in out) return out;
    if ('estimate' in out.ok) return { ok: { estimate: out.ok.estimate, makes: out.ok.makes, items } };
    const runId = out.ok.setup_run.id;
    db.prepare('INSERT INTO setup_calls (id, user_id, table_id, sheet_id, items) VALUES (?, ?, ?, ?, ?)')
      .run(runId, userId, tableId, sheetId, items);
    started = true;
    return { ok: { setup_call: getSetupCall(userId, runId)! } };
  } finally {
    if (!started) removeWorkingTable(userId, tableId);
  }
}

export async function callSetup(
  userId: string, setupId: string, rawItems: unknown, input: CallInput, caller: { hasSecretsScope: boolean },
): Promise<CallOutcome> {
  const setup = getSetup(userId, setupId);
  if (!setup) return { fail: 'not_found', message: 'Setup not found' };
  const items = itemsOf(rawItems, setup.spec.inputs);
  if (typeof items === 'string') return bad(items);
  const work = newWorkingTable(userId, setup.spec);
  if ('fail' in work) return work;
  const appended = withoutChangeLog(() => appendRows(work.sheetId, userId, items));
  if ('fail' in appended) {
    removeWorkingTable(userId, work.tableId);
    return bad(txnFailMessage(appended, MAX_ROWS_PER_SHEET));
  }
  return startCall(userId, setupId, work, input, caller);
}

// The sweep: the working tables of calls finished SETUP_CALL_KEEP_HOURS ago, and of calls that never started (a
// restart between the table and the run, or an upload link never used) SETUP_CALL_ORPHAN_HOURS after they were
// made.
export function sweepSetupCalls(): number {
  const due = db.prepare(`SELECT c.user_id, c.table_id FROM setup_calls c JOIN setup_runs r ON r.id = c.id
      WHERE r.status IN ('done', 'failed', 'cancelled') AND r.updated_at <= datetime('now', ?)
    UNION ALL
    SELECT t.user_id, t.id FROM tables t WHERE t.hidden = 1 AND t.trash_id IS NULL
      AND t.created_at <= datetime('now', ?) AND NOT EXISTS (SELECT 1 FROM setup_calls c WHERE c.table_id = t.id)`)
    .all(`-${SETUP_CALL_KEEP_HOURS} hours`, `-${SETUP_CALL_ORPHAN_HOURS} hours`) as
    Array<{ user_id: string; table_id: string }>;
  const sheetOf = db.prepare('SELECT id FROM sheets WHERE table_id = ?').pluck();
  for (const d of due) {
    // A file still being imported into it (an upload link's) holds its sheet: the next sweep looks again.
    const sheet = sheetOf.get(d.table_id) as string | undefined;
    if (sheet && sheetBusyWith(sheet)) continue;
    try { removeWorkingTable(d.user_id, d.table_id); } catch (err) {
      console.error(`A setup call's working table ${d.table_id} couldn't be removed (tried again next sweep):`, err);
    }
  }
  return due.length;
}

const SWEEP_MS = 10 * 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
export function startSetupCallLoop(): void {
  if (timer) return;
  timer = setInterval(() => { sweepSetupCalls(); }, SWEEP_MS);
  timer.unref?.();
}
