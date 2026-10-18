// What undoing a run would do, and why it can't now (pure reads): the app's
// column menu ("Undo last run"), GET /api/v1/{ai,http}-runs/:id/undo and MCP
// undo_run's dry run. services/run-undo.ts does it.
import { db } from '../lib/db';
import { UNDO_KEEP_DAYS } from '../lib/constants';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';
import { getLockedRunColumns } from '../lib/run-locked-columns';
import { runColumnOf } from './run-controls-column';

export type UndoRunKind = 'ai' | 'http';
export type UndoState = 'kept' | 'undoing' | 'undone' | 'dropping';

export interface UndoView {
  run_id: string; run_type: UndoRunKind; sheet_id: string; column: string | null;
  // none: the run kept nothing to undo (no cells written, or its journal is gone).
  state: UndoState | 'none';
  rows: number;                      // rows whose cells the run wrote
  restored: number; skipped: number; gone: number;
  started_at: string; undone_at: string | null; kept_until: string | null;
  can_undo: boolean; reason: string | null;
}

export interface RunInfo {
  id: string; kind: UndoRunKind; sheet_id: string; status: string; placeholder_work: string | null;
  column: string | null; created_at: string;
}
export interface Journal {
  id: number; columns: string; stamp_path: string | null; row_count: number; state: UndoState;
  restored: number; skipped: number; gone: number; created_at: string; undone_at: string | null; expired: number;
}

// A run that writes cells still: going, or clearing its ⏳ (alias r).
const ACTIVE = "(r.status IN ('pending', 'running', 'paused') OR r.placeholder_work IS NOT NULL)";
const iso = (at: string) => `${at.replace(' ', 'T')}Z`;

// A run as an undo reads it (its column: the one holding its per-row state).
const RUN_ROW: Record<UndoRunKind, string> = {
  ai: `SELECT id, user_id, sheet_id, status, placeholder_work, column_name AS column, created_at
    FROM ai_runs WHERE id = ?`,
  http: `SELECT id, user_id, sheet_id, status, placeholder_work, master_column_name AS column, created_at
    FROM http_runs WHERE id = ?`,
};
export function runRow(kind: UndoRunKind, runId: string): (RunInfo & { user_id: string }) | null {
  const r = db.prepare(RUN_ROW[kind]).get(runId) as Omit<RunInfo, 'kind'> & { user_id: string } | undefined;
  return r ? { ...r, kind } : null;
}

// The run, while its sheet is live (a sheet in the trash hides its runs).
export function runOf(kind: UndoRunKind, runId: string, userId: string): RunInfo | null {
  const r = runRow(kind, runId);
  return r && r.user_id === userId && verifySheetOwnership(r.sheet_id, userId) ? r : null;
}

export function journalOf(kind: UndoRunKind, runId: string, userId: string): Journal | null {
  return (db.prepare(`SELECT id, columns, stamp_path, row_count, state, restored, skipped, gone, created_at,
      undone_at, created_at <= datetime('now', ?) AS expired
    FROM run_undos WHERE run_kind = ? AND run_id = ? AND user_id = ?`)
    .get(`-${UNDO_KEEP_DAYS} days`, kind, runId, userId) as Journal | undefined) ?? null;
}

export const journalColumns = (j: Journal): Array<string | null> => {
  try { const v = JSON.parse(j.columns); return Array.isArray(v) ? v : []; } catch { return []; }
};

// Columns some other run is writing now, or clearing its ⏳ from: its
// outputs, and whatever its own journal has met so far.
function columnsBeingWritten(sheetId: string, userId: string): Set<string> {
  const out = getLockedRunColumns(sheetId, userId);
  const more = db.prepare(`SELECT a.extracted_column_name FROM http_column_associations a
      JOIN http_runs r ON r.id = a.run_id WHERE r.sheet_id = ? AND r.user_id = ? AND ${ACTIVE}
    UNION ALL SELECT j.value FROM run_undos u, json_each(u.columns) j WHERE u.sheet_id = ? AND u.user_id = ?
      AND j.value IS NOT NULL
      AND (EXISTS (SELECT 1 FROM ai_runs r WHERE u.run_kind = 'ai' AND r.id = u.run_id AND ${ACTIVE})
        OR EXISTS (SELECT 1 FROM http_runs r WHERE u.run_kind = 'http' AND r.id = u.run_id AND ${ACTIVE}))`)
    .pluck().all(sheetId, userId, sheetId, userId) as string[];
  for (const c of more) out.add(c);
  return out;
}

const NO_JOURNAL = 'This run has nothing to undo: it wrote no cells, ran before runs could be undone, or '
  + `ran more than ${UNDO_KEEP_DAYS} days ago.`;

// Why the run can't be undone now, or null when it can. holdingSheet: asked
// by the undo itself, inside the sheet's busy window.
export function undoRefusal(
  run: RunInfo, j: Journal | null, userId: string, opts: { holdingSheet?: boolean } = {},
): string | null {
  if (!j) return NO_JOURNAL;
  if (j.state === 'undone') return 'This run was already undone.';
  if (j.state === 'undoing') return 'This run is being undone now.';
  if (j.state === 'dropping' || j.expired) return `Runs can be undone for ${UNDO_KEEP_DAYS} days; this one is older.`;
  if (['pending', 'running', 'paused'].includes(run.status)) {
    return 'This run is still going. Stop it first: a run can be undone once it has stopped.';
  }
  if (run.placeholder_work) return "This run's ⏳ cells are still being cleared. Try again in a moment.";
  const listing = db.prepare(`SELECT 1 FROM enrichment_list_items WHERE run_id = ? AND user_id = ?
    AND status = 'pending' LIMIT 1`).get(run.id, userId);
  if (listing) return "This run's list results are still being added as rows. Undo it once they're in.";
  const busyWith = opts.holdingSheet ? null : sheetBusyWith(run.sheet_id);
  if (busyWith) return busyMessage(busyWith);
  const writing = columnsBeingWritten(run.sheet_id, userId);
  const columns = journalColumns(j).filter((c): c is string => c !== null);
  const clash = columns.find(c => writing.has(c));
  if (clash) return `A run is filling "${clash}" now. Undo this one when it stops.`;
  // Newest first: a newer run that wrote one of its columns and can still be
  // undone may hold the very values this one wrote, which the undo can't tell apart.
  const newer = db.prepare(`SELECT c.value FROM run_undos u, json_each(u.columns) c WHERE u.sheet_id = ?
      AND u.user_id = ? AND u.id > ? AND u.state IN ('kept', 'undoing')
      AND c.value IN (SELECT value FROM json_each(?)) LIMIT 1`)
    .pluck().get(run.sheet_id, userId, j.id, JSON.stringify(columns)) as string | undefined;
  return newer ? `A newer run wrote "${newer}" too. Undo that one first.` : null;
}

export function undoView(run: RunInfo, j: Journal | null, userId: string): UndoView {
  const reason = undoRefusal(run, j, userId);
  const keptUntil = j && (j.state === 'kept' || j.state === 'undoing')
    ? new Date(Date.parse(iso(j.created_at)) + UNDO_KEEP_DAYS * 86_400_000).toISOString() : null;
  return {
    run_id: run.id, run_type: run.kind, sheet_id: run.sheet_id, column: run.column, state: j?.state ?? 'none',
    rows: j?.row_count ?? 0, restored: j?.restored ?? 0, skipped: j?.skipped ?? 0, gone: j?.gone ?? 0,
    started_at: iso(run.created_at), undone_at: j?.undone_at ? iso(j.undone_at) : null, kept_until: keptUntil,
    can_undo: reason === null, reason,
  };
}

export function undoViewOf(userId: string, kind: UndoRunKind, runId: string): UndoView | null {
  const run = runOf(kind, runId, userId);
  return run ? undoView(run, journalOf(kind, runId, userId), userId) : null;
}

const LAST_KEPT: Record<UndoRunKind, string> = {
  ai: `SELECT r.id FROM ai_runs r
      JOIN run_undos u ON u.run_kind = 'ai' AND u.run_id = r.id AND u.state IN ('kept', 'undoing')
    WHERE r.sheet_id = ? AND r.user_id = ? AND r.column_name = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`,
  http: `SELECT r.id FROM http_runs r
      JOIN run_undos u ON u.run_kind = 'http' AND u.run_id = r.id AND u.state IN ('kept', 'undoing')
    WHERE r.sheet_id = ? AND r.user_id = ? AND r.master_column_name = ?
    ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`,
};

// "Undo last run" on a column: its newest run whose undo is still kept or
// going (an undone one is passed over, so the run before it comes next).
export function lastUndoable(userId: string, sheetId: string, column: string): UndoView | null {
  const col = runColumnOf(sheetId, userId, column);
  if (!col) return null;
  const kind: UndoRunKind = col.kind === 'ai' ? 'ai' : 'http';
  const runId = db.prepare(LAST_KEPT[kind]).pluck().get(sheetId, userId, col.main) as string | undefined;
  return runId ? undoViewOf(userId, kind, runId) : null;
}
