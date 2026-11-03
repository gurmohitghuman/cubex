// History for rows Cubex removes as they go, a few at a time, into a sheet's
// trash batch of the day: a list job's reruns (services/trash-replaced.ts) and
// auto-dedupe (services/auto-dedupe-remove.ts). One line for a run of them,
// not one per removal: the sheet's newest line, when it is today's line of
// the same kind for the same batch (and column), counts the new rows too. The
// other kind's lines are looked past: a list rerun into a sheet with
// auto-dedupe writes both, in turn, for every source row. Any other change in
// between starts a new line. Call inside the transaction that removes the
// rows: the line goes with them. A line never fails the removal.
import { db } from '../lib/db';
import { logSheetChange, rewriteSheetChange } from '../lib/change-log';

export interface RemovalLog {
  sheetId: string; userId: string;
  how: 'rerun' | 'auto_dedupe';
  // The batch they went to, or null when Settings keeps deleted rows 0 days.
  trashId: number | null;
  count: number;
  summary: (rows: number) => string;
  // The column the removals are about (auto-dedupe's key): History can filter by it.
  column?: string;
}

const KINDS = new Set<unknown>(['rerun', 'auto_dedupe']);
type Line = { id: number; action: string; column_name: string | null; detail: string | null; today: number };
type Detail = { how?: unknown; rows?: unknown; trash_id?: unknown };

const parse = (raw: string | null): Detail | null => {
  try { return raw ? JSON.parse(raw) as Detail : null; } catch { return null; }
};

// The line to count these rows on: the newest line, past the other kind's.
function lineToExtend(r: RemovalLog): { id: number; rows: number } | null {
  const recent = db.prepare(`SELECT id, action, column_name, detail, date(at) = date('now') AS today
    FROM sheet_changes WHERE sheet_id = ? ORDER BY id DESC LIMIT 4`).all(r.sheetId) as Line[];
  for (const line of recent) {
    const detail = parse(line.detail);
    const removal = line.action === 'rows_deleted' && KINDS.has(detail?.how);
    if (removal && detail!.how !== r.how) continue;
    const same = removal && line.today && detail!.trash_id === r.trashId
      && line.column_name === (r.column ?? null) && typeof detail!.rows === 'number';
    return same ? { id: line.id, rows: detail!.rows as number } : null;
  }
  return null;
}

// Counts what each call removed, so a restore of part of the batch meanwhile
// never makes the line say fewer than went.
export function logRemoval(r: RemovalLog): void {
  if (r.count <= 0) return;
  try {
    const line = lineToExtend(r);
    if (line) {
      const rows = line.rows + r.count;
      rewriteSheetChange(line.id, r.summary(rows), { rows, trash_id: r.trashId, how: r.how });
    } else {
      logSheetChange(r.sheetId, r.userId, 'rows_deleted', r.summary(r.count),
        { column: r.column ?? null, detail: { rows: r.count, trash_id: r.trashId, how: r.how } });
    }
  } catch (error) {
    console.error(`Writing the History line for removed rows of sheet ${r.sheetId} failed:`, error);
  }
}
