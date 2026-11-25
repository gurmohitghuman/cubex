// Auto-delete's sweep (API process, every AUTO_DELETE_SWEEP_MS; services/webhook-auto-delete.ts says what it
// does). For each webhook sheet with it on, a read first: is there a finished row older than the newest
// keep_rows (services/webhook-auto-delete-rows.ts)? Only then a bulk writer (lib/bulk-slices.ts): slices of at
// most AUTO_DELETE_SLICE_ROWS rows, each one transaction that checks again, copies and deletes
// (services/webhook-auto-delete-move.ts). Where it got to in the sheet is kept in memory between sweeps, so rows
// waiting on a slow auto-run are looked at a window a sweep, not all again; a restart starts from the top.
// It never works while a run is active on the sheet or the sheet it copies to (a run writes by row position or
// owns its columns), while either is busy, the sheet is held by a long read, auto-dedupe checks it, or a clean,
// formula or lookup column still has rows to work out after a stopped run. Auto-run's runs come and go between
// its sweeps and this goes in between; kept out by them for AUTO_DELETE_STARVED_MS, it asks the sheet to start
// none for a while.
import { db } from '../lib/db';
import {
  AUTO_DELETE_SCAN_ROWS, AUTO_DELETE_SLICE_ROWS, AUTO_DELETE_SLICES_PER_SWEEP, AUTO_DELETE_STARVED_MS,
  AUTO_DELETE_SWEEP_MS, AUTO_DELETE_YIELD_MS,
} from '../lib/constants';
import { asBulkWriter } from '../lib/bulk-slices';
import { sheetBusyWith, sheetHeld } from '../lib/sheet-busy';
import { yieldSheetToUser } from '../lib/sheet-yield';
import { autoDedupeChecking } from '../lib/auto-dedupe/store';
import { hasSpanWork } from '../lib/derived-spans';
import { getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import { countOf, logSheetChange } from '../lib/change-log';
import { listRunInto } from './enrich-list-guard';
import { autoRunsHolding, finishedRows, newestLeaving } from './webhook-auto-delete-rows';
import { copyRows, deleteRows, logRows, type CopyTo } from './webhook-auto-delete-move';
import type { AutoDeleteRow } from './webhook-auto-delete';
import { compileAutoDeleteRules } from './webhook-auto-delete-rules';
import type { CompiledFilter } from '../lib/row-filter/sql';
import { sheetColumnKinds } from '../lib/column-types';

// Source id → the last row looked at; the time runs started keeping finished rows waiting; when its destination
// last refused a copy (a restart tries again at once).
const after = new Map<string, number>();
const keptOutSince = new Map<string, number>();
const copyRefusedAt = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;
let sweeping = false;
const COPY_RETRY_MS = 60_000;

// What keeps it out of a sheet now: nothing, only auto-run's own runs (they end soon), or anything else (a
// person's run, a paused one, a list run adding rows to it).
function runsIn(sheetId: string, userId: string): 'none' | 'autorun' | 'other' {
  const http = db.prepare(`SELECT autorun_id, status FROM http_runs
    WHERE sheet_id = ? AND user_id = ? AND status IN ('pending', 'running', 'paused')`)
    .all(sheetId, userId) as Array<{ autorun_id: string | null; status: string }>;
  const ai = db.prepare(`SELECT 1 FROM ai_runs WHERE sheet_id = ? AND user_id = ?
    AND status IN ('pending', 'running', 'paused') LIMIT 1`).get(sheetId, userId);
  const list = listRunInto(sheetId, userId);
  if (http.length === 0 && !ai && !list) return 'none';
  return !ai && !list && http.every(r => r.autorun_id && r.status !== 'paused') ? 'autorun' : 'other';
}
const sheetsOf = (cfg: AutoDeleteRow): string[] =>
  (cfg.copy_to_sheet_id === null ? [cfg.sheet_id] : [cfg.sheet_id, cfg.copy_to_sheet_id]);

interface Pause { reason: 'success_column' | 'copy_gone' | 'copy' | 'order' | 'rules'; message: string }

// Mode rules: its where compiled against the sheet as it is now (a column it names may be gone, or be filling
// for a moment); null otherwise.
function rulesOf(cfg: AutoDeleteRow): { ok: CompiledFilter | null } | { wait: true } | { error: string } {
  if (cfg.mode !== 'rules' || cfg.where_json === null) return { ok: null };
  return compileAutoDeleteRules(cfg.sheet_id, cfg.user_id, cfg.where_json);
}

// Every run column of the sheet and the column holding its state: a ⏳ or ➕ in any keeps its row.
const runColumnsOf = (cfg: AutoDeleteRow): string[] => {
  const kinds = sheetColumnKinds(cfg.sheet_id, cfg.user_id).runState;
  return [...new Set([...kinds.keys(), ...kinds.values()])];
};

// Why no row may leave until the person acts, or null.
function needsPerson(cfg: AutoDeleteRow): Pause | null {
  const generation = db.prepare('SELECT row_generation FROM sheets WHERE id = ?').pluck().get(cfg.sheet_id);
  if (generation !== cfg.row_generation_seen) {
    return { reason: 'order', message: 'Rows were sorted, imported or had duplicates removed since auto-delete '
      + 'was saved, so the rows at the bottom may not be the newest. Check the order, then save auto-delete again.' };
  }
  const rules = rulesOf(cfg);
  if ('error' in rules) {
    const error = /[.!?]$/.test(rules.error) ? rules.error : `${rules.error}.`;
    return { reason: 'rules', message: `The rules can't be checked: ${error} Change the rules, or the sheet.` };
  }
  if (cfg.success_column !== null && !getSheetColumns(cfg.sheet_id, cfg.user_id).includes(cfg.success_column)) {
    return { reason: 'success_column',
      message: `The success column "${cfg.success_column}" isn't in the sheet any more. Pick another, or none.` };
  }
  if (cfg.copy_to_sheet_id !== null && !verifySheetOwnership(cfg.copy_to_sheet_id, cfg.user_id)) {
    return { reason: 'copy_gone',
      message: 'The sheet rows are copied to is in the trash or was deleted. Restore it, or pick another sheet.' };
  }
  return null;
}

// A new pause is written and goes in the sheet's History once; null clears it.
function setPaused(cfg: AutoDeleteRow, pause: Pause | null): void {
  if ((pause?.message ?? null) === cfg.paused_message) return;
  db.prepare(`UPDATE webhook_auto_delete SET paused_reason = ?, paused_message = ?,
    paused_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END WHERE source_id = ?`)
    .run(pause?.reason ?? null, pause?.message ?? null, pause?.reason ?? null, cfg.source_id);
  cfg.paused_reason = pause?.reason ?? null;
  cfg.paused_message = pause?.message ?? null;
  if (pause) logSheetChange(cfg.sheet_id, cfg.user_id, 'webhook', `Auto-delete paused: ${pause.message}`);
}

// The settings still as the sweep read them (a save within the same second included).
function unchanged(cfg: AutoDeleteRow): boolean {
  const now = db.prepare(`SELECT a.* FROM webhook_auto_delete a JOIN sheets s ON s.id = a.sheet_id
    AND s.user_id = a.user_id AND s.trash_id IS NULL WHERE a.source_id = ?`).get(cfg.source_id) as
    AutoDeleteRow | undefined;
  return !!now && now.mode === cfg.mode && now.where_json === cfg.where_json && now.keep_rows === cfg.keep_rows
    && now.success_column === cfg.success_column
    && now.copy_to_sheet_id === cfg.copy_to_sheet_id && now.row_generation_seen === cfg.row_generation_seen;
}

// Anything that keeps rows from leaving now and clears on its own.
const kept = (cfg: AutoDeleteRow, holding: Array<{ id: string }>): boolean =>
  sheetHeld(cfg.sheet_id) || autoDedupeChecking(cfg.sheet_id) || holding.some(h => hasSpanWork(h.id))
  || (cfg.copy_to_sheet_id !== null && sheetBusyWith(cfg.copy_to_sheet_id) !== null);

type Step = 'more' | 'done' | 'stop' | Pause;

// One slice, in its transaction: everything checked again, since the sweep's read or the last slice.
function slice(cfg: AutoDeleteRow, raw: string, to: CopyTo | null): Step {
  if (!unchanged(cfg)) return 'stop';
  const holding = autoRunsHolding(cfg.sheet_id, cfg.user_id);
  if (kept(cfg, holding) || sheetsOf(cfg).some(id => runsIn(id, cfg.user_id) !== 'none')) return 'stop';
  const why = needsPerson(cfg);
  if (why) return why;
  const upTo = newestLeaving(cfg.sheet_id, cfg.user_id, cfg.keep_rows);
  if (upTo === undefined) { after.delete(cfg.source_id); return 'done'; }
  const rules = rulesOf(cfg);
  if (!('ok' in rules)) return 'stop';
  const found = finishedRows({ id: cfg.sheet_id, userId: cfg.user_id, raw }, holding, cfg.success_column,
    after.get(cfg.source_id) ?? -1, upTo, AUTO_DELETE_SCAN_ROWS, AUTO_DELETE_SLICE_ROWS, rules.ok, runColumnsOf(cfg));
  let leaving = found.rowids;
  if (leaving.length > 0 && to) {
    const copied = copyRows(cfg.sheet_id, cfg.user_id, raw, leaving, to);
    if ('pause' in copied) return { reason: 'copy', message: copied.pause };
    if ('wait' in copied) return 'stop';
    leaving = copied.copied;
  }
  const gone = leaving.length === 0 ? 0 : deleteRows(cfg.sheet_id, cfg.user_id, leaving);
  if (gone > 0) {
    db.prepare(`UPDATE webhook_auto_delete SET rows_deleted = rows_deleted + ?, last_deleted_at = datetime('now'),
      paused_reason = NULL, paused_message = NULL, paused_at = NULL WHERE source_id = ?`).run(gone, cfg.source_id);
    cfg.paused_reason = null;
    cfg.paused_message = null;
    const copy = to ? `, copied to "${to.name}" first` : '';
    logRows(cfg.sheet_id, cfg.user_id, 'rows_deleted', gone, n => `Auto-delete deleted ${countOf(n, 'row')}${copy}`);
    if (to) {
      const from = db.prepare('SELECT name FROM sheets WHERE id = ?').pluck().get(cfg.sheet_id) as string;
      logRows(to.sheetId, cfg.user_id, 'rows_moved_in', gone,
        n => `Auto-delete copied in ${countOf(n, 'row')} from "${from}"`);
    }
  }
  // Fewer copied than found: the destination is full now, and the next slice says so.
  if (leaving.length < found.rowids.length) return 'more';
  if (found.end) { after.delete(cfg.source_id); return 'done'; }
  after.set(cfg.source_id, found.last);
  return 'more';
}

// Kept out by runs: only auto-run's in this sheet or the one it copies to, for long enough, asks them to yield.
function keptOutByRuns(cfg: AutoDeleteRow, now: number): boolean {
  const runs = sheetsOf(cfg).map(id => ({ id, runs: runsIn(id, cfg.user_id) }));
  if (runs.every(r => r.runs === 'none')) { keptOutSince.delete(cfg.source_id); return false; }
  if (runs.some(r => r.runs === 'other')) return true;
  const since = keptOutSince.get(cfg.source_id) ?? now;
  keptOutSince.set(cfg.source_id, since);
  if (now - since >= AUTO_DELETE_STARVED_MS) {
    for (const r of runs) if (r.runs === 'autorun') yieldSheetToUser(r.id, now, AUTO_DELETE_YIELD_MS);
    keptOutSince.set(cfg.source_id, now);
  }
  return true;
}

async function sweepSheet(cfg: AutoDeleteRow, now: number): Promise<void> {
  const raw = db.prepare('SELECT raw_column_name FROM webhook_sources WHERE id = ?').pluck()
    .get(cfg.source_id) as string | undefined;
  if (raw === undefined) return;
  const why = needsPerson(cfg);
  // A copy refusal clears only once a slice gets through; the others once fixed (a sort's once saved again).
  if (why || cfg.paused_reason !== 'copy') setPaused(cfg, why);
  const holding = autoRunsHolding(cfg.sheet_id, cfg.user_id);
  if (why || kept(cfg, holding)) return;
  // A full destination is tried again a minute on, not every sweep (each try counts its rows).
  if (cfg.paused_reason === 'copy' && now - (copyRefusedAt.get(cfg.source_id) ?? 0) < COPY_RETRY_MS) return;
  // The read: a finished row that may leave, in this sweep's window.
  const upTo = newestLeaving(cfg.sheet_id, cfg.user_id, cfg.keep_rows);
  const rules = rulesOf(cfg);
  if ('wait' in rules) return;
  const peek = upTo === undefined || !('ok' in rules) ? null : finishedRows({ id: cfg.sheet_id, userId: cfg.user_id,
    raw }, holding, cfg.success_column, after.get(cfg.source_id) ?? -1, upTo, AUTO_DELETE_SCAN_ROWS, 1, rules.ok,
    runColumnsOf(cfg));
  if (!peek || peek.rowids.length === 0) {
    keptOutSince.delete(cfg.source_id);
    if (!peek || peek.end) after.delete(cfg.source_id); else after.set(cfg.source_id, peek.last);
    return;
  }
  if (keptOutByRuns(cfg, now)) return;
  const to: CopyTo | null = cfg.copy_to_sheet_id === null ? null : {
    sheetId: cfg.copy_to_sheet_id, rows: null,
    name: db.prepare('SELECT name FROM sheets WHERE id = ?').pluck().get(cfg.copy_to_sheet_id) as string,
  };
  await asBulkWriter(async w => {
    for (let i = 0; i < AUTO_DELETE_SLICES_PER_SWEEP; i++) {
      const step = await w.slice(() => slice(cfg, raw, to));
      if (typeof step === 'object') {
        if (step.reason === 'copy') copyRefusedAt.set(cfg.source_id, now);
        setPaused(cfg, step);
        return;
      }
      if (step !== 'more') return;
    }
  });
}

export async function autoDeleteSweep(now = Date.now()): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const all = db.prepare(`SELECT a.* FROM webhook_auto_delete a JOIN sheets s ON s.id = a.sheet_id
      AND s.user_id = a.user_id AND s.trash_id IS NULL`).all() as AutoDeleteRow[];
    // What it remembers of a webhook whose auto-delete is off, or gone, is let go.
    const on = new Set(all.map(c => c.source_id));
    for (const seen of [after, keptOutSince, copyRefusedAt]) {
      for (const id of seen.keys()) if (!on.has(id)) seen.delete(id);
    }
    for (const cfg of all) {
      try {
        await sweepSheet(cfg, now);
      } catch (error) {
        console.error(`Auto-delete on sheet ${cfg.sheet_id} failed:`, error);
      }
    }
  } finally {
    sweeping = false;
  }
}

export function startWebhookAutoDeleteLoop(): void {
  if (timer) return;
  timer = setInterval(() => { void autoDeleteSweep(); }, AUTO_DELETE_SWEEP_MS);
  timer.unref?.();
}
