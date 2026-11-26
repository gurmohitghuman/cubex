// A saved setup called like a function on 1-SETUP_CALL_MAX_ITEMS items, without a sheet: one implementation for /api/v1
// (routes/api-v1-setup-calls.ts) and MCP (apply_setup with items, mcp/setup-items.ts). The items become the rows of a
// hidden working table (tables.hidden, migration 067: never listed or counted), one column per setup input, and the
// setup runs there through applySetup, as on any sheet: its ceiling, its step runs, pause, resume and stop
// (control_setup_run), the run-finished webhook (kind "setup"). The call's id is the setup run's, so polling and the
// webhook name one id. An estimate makes no working table: it is a pure read (setup-call-estimate.ts). A start refused
// removes the working table at once; a started call's table goes SETUP_CALL_KEEP_HOURS after it finishes (the sweep
// below), its results with it, and a call paused that long is stopped first. Auto-run is never turned on there
// (ApplyInput.call). The working table goes through the trash, purged at once and never listed.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import {
  SETUP_CALL_KEEP_HOURS, SETUP_CALL_MAX_ITEMS, SETUP_CALL_ORPHAN_HOURS, SETUP_CALL_SWEEP_MS,
} from '../lib/constants-setups';
import { sheetBusyWith } from '../lib/sheet-busy';
import type { SetupSpec } from '../lib/setups/spec';
import type { RateDecision } from '../lib/rate-window';
import { receiveBackstopMs } from '../lib/request-deadline';
import { FILE_LINK_TTL_MINUTES } from '../lib/api-v1-constants';
import { startRefusalMessage, takeRunStart } from './run-shared';
import { withoutChangeLog } from '../lib/change-log';
import { getSetup } from './setup-library';
import { applySetup, type ApplyFail, type ApplyInput } from './setup-apply';
import { getSetupCall, type SetupCallView } from './setup-call-view';
import { loadSetupRun } from './setup-run-store';
import { createTable } from './table-crud';
import { addSheetColumn } from './column-add';
import { appendRows } from './rows-write';
import { parseCellMap, txnFailMessage } from './data-plane-shared';
import { trashTable } from './trash-sheets';
import { purgeTrashItems } from './trash-purge';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import { estimateSetupCall } from './setup-call-estimate';
import { cancelStepRuns } from './setup-run-control';
import { cancelRun } from './run-lifecycle';

// What a call takes besides its items: apply_setup's choices that make sense without a sheet.
export type CallInput = Pick<ApplyInput, 'models' | 'estimateOnly' | 'webhookId' | 'maxCostUsd' | 'allowUnpriced'>;
export { CALL_NOT_FOUND, getSetupCall, type SetupCallView } from './setup-call-view';

// rate_limited: the token's run-start window is full (rate: for REST's Retry-After).
export type CallFail = Omit<ApplyFail, 'fail'> & { fail: ApplyFail['fail'] | 'rate_limited'; rate?: RateDecision };
type CallOk = { ok: { estimate: object; makes: string[]; items: number } } | { ok: { setup_call: SetupCallView } };
export type CallOutcome = CallOk | CallFail;
// A start on a working table that holds its items (startCall): its run-start slot was taken before.
export type StartOutcome = CallOk | ApplyFail;

const bad = (message: string): ApplyFail => ({ fail: 'bad_request', message });
// apply_setup's input for a call: no test rows, and auto-run never turned on.
const applyInputOf = (input: CallInput): ApplyInput => ({
  models: input.models, estimateOnly: input.estimateOnly, webhookId: input.webhookId ?? null,
  maxCostUsd: input.maxCostUsd ?? null, allowUnpriced: input.allowUnpriced, firstRows: null, call: true,
});

// The items, checked: an array of 1 to `max` objects keyed by the inputs of `what` (the setup, or the tool for an
// enrichment call), each value a string, number, boolean or null (a cell). An item may leave inputs out (empty).
export function itemsOf(raw: unknown, inputs: string[], max = SETUP_CALL_MAX_ITEMS, what = 'setup'):
  Array<Record<string, string>> | string {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) {
    return `items must be an array of 1 to ${max} objects, each keyed by the ${what}'s inputs`
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
      return `Item ${i} has "${unknown.slice(0, 50)}", which isn't an input of this ${what}`
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

// The setup applied on a working table that holds its items, started as a call (an estimate never makes one:
// setup-call-estimate.ts). Unless it starts, the working table is removed.
export async function startCall(
  userId: string, setupId: string, work: { tableId: string; sheetId: string }, input: CallInput,
  caller: { hasSecretsScope: boolean },
): Promise<StartOutcome> {
  const { tableId, sheetId } = work;
  let started = false;
  try {
    const items = db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND user_id = ?').pluck()
      .get(sheetId, userId) as number;
    const out = await applySetup(userId, sheetId, setupId, applyInputOf(input), caller);
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

// A start takes a slot of the access token's run-start window, as a column run's start does (run-shared.ts); a
// token at its spend cap is refused first, unless every step is free.
export function startSlot(userId: string, tokenId: string, spec: SetupSpec): CallFail | null {
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
  if (input.estimateOnly) return estimateSetupCall(userId, setup, items, applyInputOf(input), caller);
  const slot = caller.tokenId ? startSlot(userId, caller.tokenId, setup.spec) : null;
  if (slot) return slot;
  const work = newWorkingTable(userId, setup.spec);
  if ('fail' in work) return work;
  const appended = withoutChangeLog(() => appendRows(work.sheetId, userId, items));
  if ('fail' in appended) {
    removeWorkingTable(userId, work.tableId);
    return bad(txnFailMessage(appended, MAX_ROWS_PER_SHEET));
  }
  return startCall(userId, setupId, work, input, caller);
}

// A working table whose call never started (a restart between the table and the run, or an upload link never used)
// goes once no upload link can still be filling it: past the link's time to be used, the time the largest file may
// take to arrive at the slowest speed allowed (lib/request-deadline.ts), and SETUP_CALL_ORPHAN_HOURS more for its
// reading and its start. About 2.5 hours by default.
const orphanSeconds = (): number =>
  Math.ceil((FILE_LINK_TTL_MINUTES * 60_000 + receiveBackstopMs()) / 1000) + SETUP_CALL_ORPHAN_HOURS * 3600;

// A call paused SETUP_CALL_KEEP_HOURS ago (by hand, or at a limit, the token's cap or its ceiling) and not resumed
// since is stopped, as control_setup_run's (or, for an enrichment call, control_run's) cancel stops it; its results
// are then kept as any finished call's.
export const STALE_PAUSE = `Paused for more than ${SETUP_CALL_KEEP_HOURS} hours, so it was stopped.`;
async function stopStalePaused(keep: string): Promise<void> {
  const stale = db.prepare(`SELECT c.id FROM setup_calls c JOIN setup_runs r ON r.id = c.id
    WHERE r.status = 'paused' AND r.updated_at <= datetime('now', ?)`).pluck().all(keep) as string[];
  const stop = db.prepare(`UPDATE setup_runs SET status = 'cancelled', error_message = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'paused' AND updated_at <= datetime('now', ?)`);
  for (const id of stale) {
    // Resumed meanwhile: it goes on.
    if (stop.run(STALE_PAUSE, id, keep).changes === 0) continue;
    try { await cancelStepRuns(loadSetupRun(id)!); } catch (err) {
      console.error(`Setup call ${id}'s runs couldn't all be stopped:`, err);
    }
  }
  // An enrichment call is its run. Why it stopped is written only while it is still paused that long, and the
  // cancel's own flip follows with nothing awaited between, so a resume meanwhile keeps it going.
  const runs = db.prepare(`SELECT c.id, c.user_id FROM enrichment_item_calls c JOIN http_runs r ON r.id = c.id
    WHERE r.status = 'paused' AND r.updated_at <= datetime('now', ?)`).all(keep) as
    Array<{ id: string; user_id: string }>;
  const why = db.prepare(`UPDATE http_runs SET error_message = ? WHERE id = ? AND status = 'paused'
    AND updated_at <= datetime('now', ?)`);
  for (const r of runs) {
    if (why.run(STALE_PAUSE, r.id, keep).changes === 0) continue;
    try { await cancelRun('http', r.id, r.user_id); } catch (err) {
      console.error(`Enrichment call ${r.id} couldn't be stopped:`, err);
    }
  }
}

// A call's sheet stays in call_sheets after its working table goes: the usage history (kept as long as run_usage,
// with no window) and Settings' spend card name its spend as a call's. One small row a call, fewer than its runs.

// The sweep: calls paused too long are stopped; then the working tables of calls (setup and enrichment calls)
// finished SETUP_CALL_KEEP_HOURS ago, and of calls that never started, are removed. Returns how many it removed.
export async function sweepSetupCalls(): Promise<number> {
  await stopStalePaused(`-${SETUP_CALL_KEEP_HOURS} hours`);
  const due = db.prepare(`SELECT c.user_id, c.table_id FROM setup_calls c JOIN setup_runs r ON r.id = c.id
      WHERE r.status IN ('done', 'failed', 'cancelled') AND r.updated_at <= datetime('now', ?)
    UNION ALL
    SELECT c.user_id, c.table_id FROM enrichment_item_calls c JOIN http_runs r ON r.id = c.id
      WHERE r.status IN ('completed', 'failed', 'cancelled') AND r.updated_at <= datetime('now', ?)
    UNION ALL
    SELECT t.user_id, t.id FROM tables t WHERE t.hidden = 1 AND t.trash_id IS NULL
      AND t.created_at <= datetime('now', ?) AND NOT EXISTS (SELECT 1 FROM setup_calls c WHERE c.table_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM enrichment_item_calls c WHERE c.table_id = t.id)`)
    .all(`-${SETUP_CALL_KEEP_HOURS} hours`, `-${SETUP_CALL_KEEP_HOURS} hours`, `-${orphanSeconds()} seconds`) as
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

let timer: ReturnType<typeof setInterval> | null = null;
export function startSetupCallLoop(): void {
  if (timer) return;
  timer = setInterval(() => {
    sweepSetupCalls().catch(err => console.error('The setup call sweep failed (tried again next time):', err));
  }, SETUP_CALL_SWEEP_MS);
  timer.unref?.();
}
