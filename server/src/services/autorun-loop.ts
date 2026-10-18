// The auto-run loop (API process, every AUTORUN_SWEEP_MS). For each column
// with auto-run on, it starts a small run on the rows waiting for it (new
// rows, rows whose inputs were just written), at most AUTORUN_MAX_ROWS at a
// time, within today's caps. A column is skipped while its sheet is busy or
// yielding to the user (lib/sheet-yield.ts), while a run on it is active or
// clearing, and while it is paused. Pauses that can clear on their own are
// cleared here: caps when today allows a row again (midnight UTC or a raise),
// treg's stops after AUTORUN_RETRY_MS, a missing column once it is back, a
// missing key once one is saved, a loop of list auto-runs once it is broken.
import { usesTreg } from '../lib/waterfall/caps';
import { db } from '../lib/db';
import { AUTORUN_MAX_ROWS, AUTORUN_RETRY_MS, AUTORUN_SWEEP_MS } from '../lib/constants';
import { sheetBusyWith } from '../lib/sheet-busy';
import { sheetYielding } from '../lib/sheet-yield';
import { getSheetColumns } from '../lib/sql-helpers';
import { missingRequestRead, requestColumns, watchedColumns, type CandidatePlan } from '../lib/autorun-rules';
import type { HTTPAPIConfig } from '../lib/http-request-template';
import { isEnrichmentConfig } from '../lib/enrich-run-config';
import { getTregToken } from './treg-key';
import {
  CAPACITY_PAUSES, RETRY_PAUSES, clearEntryPause, columnRunActive, inputColumnsOf, loadEntry, newestRunOf,
  pauseEntry, ruleOf, ruleReads, usableKeyNames, whereOf, type AutorunEntry,
} from './autorun-entry';
import { autorunCapacity } from './autorun-capacity';
import { pickRows } from './autorun-pick';
import { prepareAutorunRun, startAutorunRun } from './autorun-start';
import { autorunLoopProblem, destHasRoom } from './autorun-list';
import { generationMoved, hasWork } from './autorun-fence';
import { derivedFollowTick } from './derived-follow';
import { isFollowKind } from '../lib/autorun-kick';
import { isWaterfallConfig, onSteps } from '../lib/waterfall/config';
import { getOpenRouterApiKey } from './openrouter';

interface Setup { config: HTTPAPIConfig; newest: NonNullable<ReturnType<typeof newestRunOf>>; columns: string[] }

function setupOf(e: AutorunEntry): Setup | { reason: string; message: string } {
  const newest = newestRunOf(e.sheet_id, e.user_id, e.status_column);
  let config: HTTPAPIConfig | null = null;
  try { config = JSON.parse(newest?.config ?? 'null'); } catch { /* below */ }
  if (!newest || !config?.requestConfig) {
    return { reason: 'setup', message: 'This column has no run to repeat. Run it once, then turn auto-run on again.' };
  }
  if (!ruleReads(e)) {
    return { reason: 'setup', message: 'Its "Only run if" rule no longer reads. Edit the rule in its auto-run settings.' };
  }
  const columns = getSheetColumns(e.sheet_id, e.user_id, false);
  // The columns it watches follow the newest run (a run started elsewhere can read others).
  // A column it watched before still counts: an HTTP request's token for a deleted column
  // would otherwise read as plain text (or a saved key's value), and that column must come
  // back first. A {{name}} that names no column or usable saved key waits too (lib/autorun-rules.ts).
  const before = inputColumnsOf(e);
  const reads = watchedColumns(requestColumns(config, [...columns, ...before]), whereOf(e), e.run_if);
  // Its own column too: a CSV replace can drop it, and results would land in a column the grid doesn't list.
  const gone = [e.status_column, ...reads].find(c => !columns.includes(c))
    ?? missingRequestRead(config, columns, before, usableKeyNames(e.user_id, newest.allow_secrets));
  if (gone) {
    return { reason: 'missing_input', message: `${gone} isn't in this sheet anymore. Auto-run waits until it's back.` };
  }
  const watched = JSON.stringify(reads);
  if (watched !== e.input_columns) {
    db.prepare('UPDATE autorun_columns SET input_columns = ? WHERE id = ?').run(watched, e.id);
  }
  const steps = isWaterfallConfig(config) ? onSteps(config.waterfall) : [];
  if ((isEnrichmentConfig(config) || steps.some(usesTreg)) && !getTregToken(e.user_id)) {
    return { reason: 'no_key', message: 'No treg key. Add one in Settings and auto-run goes on.' };
  }
  if (steps.some(s => s.built.kind === 'ai') && !getOpenRouterApiKey(e.user_id)) {
    return { reason: 'no_key', message: 'No OpenRouter key. Add one in Settings and auto-run goes on.' };
  }
  return { config, newest, columns };
}

const pausedMs = (at: string | null): number => (at ? Date.now() - Date.parse(`${at.replace(' ', 'T')}Z`) : Infinity);

// Whether a paused entry may go on now (and clears its pause if so).
function pauseLifted(e: AutorunEntry): boolean {
  const reason = e.paused_reason!;
  let lifted = false;
  if (RETRY_PAUSES.has(reason)) lifted = pausedMs(e.paused_at) >= AUTORUN_RETRY_MS;
  else if (reason === 'missing_input' || reason === 'no_key') lifted = !('reason' in setupOf(e));
  else if (reason === 'dest_full') lifted = destHasRoom(e);
  else if (reason === 'loop') lifted = autorunLoopProblem(e) === null;
  else if (CAPACITY_PAUSES.has(reason)) {
    const s = setupOf(e);
    lifted = !('reason' in s) && 'rows' in autorunCapacity(e, s.config);
  }
  // Only the pause it looked at: a person's newer pause stays.
  return lifted && clearEntryPause(e.id, reason);
}

export async function autorunTick(id: string): Promise<void> {
  // Read now, not at the sweep's start: the ticks before this one awaited, and
  // a sort, an import or a person may have moved this entry meanwhile.
  const e = loadEntry(id);
  if (!e || !e.enabled) return;
  // A clean or formula column follows its inputs: free, no run, no caps (derived-follow.ts).
  if (isFollowKind(e.kind)) return derivedFollowTick(e);
  if (e.paused_reason && !pauseLifted(e)) return;
  if (sheetBusyWith(e.sheet_id) || sheetYielding(e.sheet_id)) return;
  if (generationMoved(e) || !hasWork(e)) return;
  if (columnRunActive(e.sheet_id, e.user_id, e.status_column)) return;
  // Every time: a run started by hand can point a list column somewhere that adds rows back.
  const loop = autorunLoopProblem(e);
  if (loop) { pauseEntry(e.id, 'loop', loop); return; }
  const setup = setupOf(e);
  if ('reason' in setup) { pauseEntry(e.id, setup.reason, setup.message); return; }
  const room = autorunCapacity(e, setup.config);
  if (!('rows' in room)) { pauseEntry(e.id, room.reason, room.message); return; }

  const plan: CandidatePlan = {
    kind: e.kind, statusColumn: e.status_column, config: setup.config, columns: setup.columns,
    requestCols: requestColumns(setup.config, setup.columns), where: whereOf(e), rule: ruleOf(e),
  };
  let picked = await pickRows(e, plan, Math.min(room.rows, AUTORUN_MAX_ROWS));
  if (picked.rows.length === 0) {
    db.prepare(`UPDATE autorun_columns SET watermark_row_index = ? WHERE id = ? AND watermark_row_index = ?
      AND row_generation_seen = ? AND rescan = 0`)
      .run(picked.watermark, e.id, e.watermark_row_index, e.row_generation_seen);
    return;
  }
  let prep = await prepareAutorunRun(e, setup.newest, setup.config, plan, picked.rows.length, room.runLimitUsd);
  if ('repriced' in prep) {
    // treg prices the tool now: the room at those prices, and a pick that fits
    // it (picking takes nothing: the start does).
    const priced = autorunCapacity(e, prep.repriced);
    if (!('rows' in priced)) { pauseEntry(e.id, priced.reason, priced.message); return; }
    picked = await pickRows(e, plan, Math.min(priced.rows, AUTORUN_MAX_ROWS));
    if (picked.rows.length === 0) return;
    prep = await prepareAutorunRun(e, setup.newest, setup.config, plan, picked.rows.length, priced.runLimitUsd);
  }
  if ('pause' in prep) { pauseEntry(e.id, prep.pause.reason, prep.pause.message); return; }
  if ('repriced' in prep || 'retry' in prep) return;
  await startAutorunRun(e, plan, picked, prep.ok);
}

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

export async function autorunSweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    // A sheet in the trash is passed by (services/trash-sheets.ts).
    const entries = db.prepare(`SELECT id, sheet_id, status_column FROM autorun_columns WHERE enabled = 1
      AND sheet_id IN (SELECT id FROM sheets WHERE trash_id IS NULL) ORDER BY updated_at`)
      .all() as Array<Pick<AutorunEntry, 'id' | 'sheet_id' | 'status_column'>>;
    for (const e of entries) {
      try { await autorunTick(e.id); }
      catch (err) { console.error(`Auto-run on "${e.status_column}" (sheet ${e.sheet_id}) failed this round:`, err); }
    }
  } finally { sweeping = false; }
}

export function startAutorunLoop(): void {
  if (timer) return;
  timer = setInterval(() => { void autorunSweep(); }, AUTORUN_SWEEP_MS);
  timer.unref?.();
}
