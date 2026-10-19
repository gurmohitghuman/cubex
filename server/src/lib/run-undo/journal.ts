// Keeping what a run overwrites (migration 041), from inside the transactions
// that write its cells: the run's ⏳ seeding (a slice of rows at a time, in
// SQL), each row's result (lib/run-cells-write.ts) and a list job's words that
// follow. A row's cells are kept once, before the run's first write to them;
// later writes only move their print. Plain DB writes: run workers call them.
import { db } from '../db';
import { jsonPath } from '../json-path';
import { parseRowData } from '../sql-rows';
import { cellPrint, type JournalCell } from './print';

export interface RunRef { kind: 'ai' | 'http'; id: string }
// The rows a seeding statement writes: by rowid or by rows.id (a JSON list).
export type SeedRows = { rowids: string } | { ids: string };

interface Journal { id: number; slots: number[] }

const parseColumns = (raw: string): Array<string | null> => {
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
};

// A run started before runs could be undone (migration 041 applied after it
// began) has written cells nothing kept: a journal begun now would keep its
// own ⏳ as their old values, and its undo would empty cells that held data.
// Such a run keeps nothing (it can't be undone) and writes as usual.
const BEGAN_BEFORE_UNDO: Record<RunRef['kind'], string> = {
  ai: `SELECT 1 FROM ai_runs r, _migrations m WHERE r.id = ? AND r.user_id = ? AND m.name = '041_run_undo.sql'
    AND r.created_at < m.applied_at`,
  http: `SELECT 1 FROM http_runs r, _migrations m WHERE r.id = ? AND r.user_id = ? AND m.name = '041_run_undo.sql'
    AND r.created_at < m.applied_at`,
};

// The run's journal (made by its first write) with a slot for each of
// `names`; 'closed' when it takes no more (undone, or going); 'unkept' for a
// run that began before runs could be undone (it keeps nothing).
function journalFor(
  run: RunRef, sheetId: string, userId: string, names: string[], stampPath: string | null = null,
): Journal | 'closed' | 'unkept' {
  const read = () => db.prepare(`SELECT id, columns, stamp_path, state FROM run_undos
    WHERE run_kind = ? AND run_id = ? AND user_id = ?`).get(run.kind, run.id, userId) as
    { id: number; columns: string; stamp_path: string | null; state: string } | undefined;
  let j = read();
  if (!j) {
    if (db.prepare(BEGAN_BEFORE_UNDO[run.kind]).get(run.id, userId)) return 'unkept';
    db.prepare('INSERT INTO run_undos (user_id, sheet_id, run_kind, run_id) VALUES (?, ?, ?, ?)')
      .run(userId, sheetId, run.kind, run.id);
    j = read()!;
  }
  if (j.state !== 'kept') return 'closed';
  const columns = parseColumns(j.columns);
  const before = columns.length;
  const slots = names.map(name => {
    const at = columns.indexOf(name);
    return at >= 0 ? at : columns.push(name) - 1;
  });
  const newStamp = stampPath !== null && j.stamp_path !== stampPath;
  if (columns.length !== before || newStamp) {
    db.prepare('UPDATE run_undos SET columns = ?, stamp_path = COALESCE(?, stamp_path) WHERE id = ?')
      .run(JSON.stringify(columns), newStamp ? stampPath : null, j.id);
  }
  return { id: j.id, slots };
}

// Seeding: `cells` go into `rows` (minus those at the row_index values in
// `skipIndexes`) by the statement that follows in the same transaction. The
// rows' values now are kept, with the print of what goes in.
export function journalSeed(
  run: RunRef, sheetId: string, userId: string, rows: SeedRows, cells: Array<[string, string]>,
  skipIndexes = '[]',
): void {
  if (cells.length === 0) return;
  const j = journalFor(run, sheetId, userId, cells.map(c => c[0]));
  if (typeof j === 'string') return;
  const which = 'rowids' in rows ? 'rowid' : 'id';
  const info = db.prepare(`INSERT INTO run_undo_rows (undo_id, row_id, ref, cells)
    SELECT ?, rowid, substr(id, 1, 8), json_array(${cells.map(() => 'json_array(?, data -> ?, ?)').join(', ')})
    FROM rows WHERE ${which} IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?
      AND row_index NOT IN (SELECT value FROM json_each(?))
    ON CONFLICT (undo_id, row_id) DO NOTHING`).run(
    j.id, ...cells.flatMap(([column, value], i) => [j.slots[i], jsonPath(column), cellPrint(value)]),
    'rowids' in rows ? rows.rowids : rows.ids, sheetId, userId, skipIndexes,
  );
  if (info.changes === 0) return;
  db.prepare('UPDATE run_undos SET row_count = row_count + ? WHERE id = ?').run(info.changes, j.id);
}

interface RowNow {
  rid: number; id: string; data: string; stamp_now: string | null;
  ref: string | null; cells: string | null; stamp: string | null;
}

// One row's write by the run (its result): the cells' values now are kept the
// first time, their prints follow every write, and the row's run_inputs entry
// under `stampPath` is kept before the run's first stamp replaces it. False:
// the run was undone (or its undo has begun), and it writes nothing again.
// True without keeping anything for a run that began before runs could be undone.
export function journalRowWrite(
  run: RunRef, sheetId: string, userId: string, rowIndex: number, cells: Array<[string, string]>,
  stampPath: string | null,
): boolean {
  const j = journalFor(run, sheetId, userId, cells.map(c => c[0]), stampPath);
  if (j === 'closed') return false;
  if (j === 'unkept') return true;
  const row = db.prepare(`SELECT r.rowid AS rid, r.id, r.data, r.run_inputs -> ? AS stamp_now,
      u.ref, u.cells, u.stamp
    FROM rows r LEFT JOIN run_undo_rows u ON u.undo_id = ? AND u.row_id = r.rowid
    WHERE r.sheet_id = ? AND r.user_id = ? AND r.row_index = ?`)
    .get(stampPath ?? '$.""', j.id, sheetId, userId, rowIndex) as RowNow | undefined;
  if (!row) return true;
  // A record under this rowid kept for a row deleted since was that row's: this one starts afresh.
  const stale = row.cells !== null && row.ref !== row.id.slice(0, 8);
  const writes = cells.map(([column, value], i) => ({ slot: j.slots[i], column, value }));
  keepRow(j.id, stale ? { ...row, cells: null, stamp: null } : row, writes, stampPath !== null);
  return true;
}

function keepRow(
  undoId: number, row: RowNow, writes: Array<{ slot: number; column: string; value: string }>, stamped: boolean,
): void {
  const data = parseRowData(row.data);
  const list: JournalCell[] = row.cells ? JSON.parse(row.cells) as JournalCell[] : [];
  for (const w of writes) {
    const kept = list.find(c => c[0] === w.slot);
    if (kept) kept[2] = cellPrint(w.value);
    else list.push([w.slot, data[w.column] ?? null, cellPrint(w.value)]);
  }
  const stamp = row.stamp ?? (stamped ? row.stamp_now ?? 'null' : null);
  db.prepare(`INSERT INTO run_undo_rows (undo_id, row_id, ref, stamp, cells) VALUES (?, ?, substr(?, 1, 8), ?, ?)
    ON CONFLICT (undo_id, row_id) DO UPDATE SET ref = excluded.ref, stamp = excluded.stamp, cells = excluded.cells`)
    .run(undoId, row.rid, row.id, stamp, JSON.stringify(list));
  if (row.ref === null) db.prepare('UPDATE run_undos SET row_count = row_count + 1 WHERE id = ?').run(undoId);
}

// A list job's words that follow its run (rows on their way, added, not
// added) into `column` of rows it already wrote: by rows.id, after the write,
// in its transaction. Only the prints move; a row the run never wrote is left out.
export function journalFollowUp(run: RunRef, userId: string, column: string, rowIds: string[], value: string): void {
  if (rowIds.length === 0) return;
  const j = db.prepare(`SELECT id, columns FROM run_undos WHERE run_kind = ? AND run_id = ? AND user_id = ?
    AND state = 'kept'`).get(run.kind, run.id, userId) as { id: number; columns: string } | undefined;
  const slot = j ? parseColumns(j.columns).indexOf(column) : -1;
  if (!j || slot < 0) return;
  const rows = db.prepare(`SELECT u.row_id, u.cells FROM run_undo_rows u JOIN rows r ON r.rowid = u.row_id
    WHERE u.undo_id = ? AND r.id IN (SELECT value FROM json_each(?)) AND substr(r.id, 1, 8) = u.ref`)
    .all(j.id, JSON.stringify(rowIds)) as Array<{ row_id: number; cells: string }>;
  const save = db.prepare('UPDATE run_undo_rows SET cells = ? WHERE undo_id = ? AND row_id = ?');
  for (const r of rows) {
    const list = JSON.parse(r.cells) as JournalCell[];
    const kept = list.find(c => c[0] === slot);
    if (!kept) continue;
    kept[2] = cellPrint(value);
    save.run(JSON.stringify(list), j.id, r.row_id);
  }
}
