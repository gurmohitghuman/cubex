// What a run's ⏳ clear (lib/placeholder-cells.ts) puts back when the run
// ended early (cancelled, failed, or failed to start): a cell still holding
// ⏳ is at a row the run never reached, so it gets the value the run's undo
// journal kept for it from before the run (journalSeed), with its JSON type,
// instead of ''. The journal is read in whatever state it is (its rows are
// what was there before the run) and never changed: a later undo of the run
// finds those cells already holding their old values ('same', restore.ts).
// The cell becomes '' as before for a run with no journal (it began before
// runs could be undone), a row without a record or whose record was another
// row's (a rowid SQLite handed to a newer row: its ref differs), a column
// without a slot, or an old value that's empty, a ⏳ or a list job's words
// (print.ts: isEmptyCell, oldValueOf, isListWords; nothing would ever replace
// those). Done in SQL inside the clear's own UPDATE: one lookup by the
// journal rows' primary key per cell that still holds ⏳, none for the rest.
import { db } from '../db';
import { BLANK_CHARS, LIST_MARK, PLACEHOLDER } from '../run-markers';
import type { RunRef } from './journal';

export interface ClearBack { undoId: number; slots: Array<number | null> }

// The run's journal and the slot of each of `columns` in it (null: none), or
// null when the run has no journal.
export function clearBackFor(run: RunRef, userId: string, columns: string[]): ClearBack | null {
  const j = db.prepare('SELECT id, columns FROM run_undos WHERE run_kind = ? AND run_id = ? AND user_id = ?')
    .get(run.kind, run.id, userId) as { id: number; columns: string } | undefined;
  if (!j) return null;
  let names: unknown = [];
  try { names = JSON.parse(j.columns); } catch { /* no slots */ }
  const list = Array.isArray(names) ? names : [];
  return { undoId: j.id, slots: columns.map(c => { const at = list.indexOf(c); return at >= 0 ? at : null; }) };
}

// The blank characters around a cell, as SQLite's ltrim takes them.
const BLANK = `char(${[...BLANK_CHARS].map(c => c.codePointAt(0)).join(', ')})`;

// SQL over the `rows` row an UPDATE is writing: the value kept for it at a
// slot, as JSON (json_replace writes it with its type), or NULL when nothing
// goes back. Its parameters: the journal's id, then the slot.
export const KEPT_VALUE_SQL = `(SELECT c.value -> 1 FROM run_undo_rows u, json_each(u.cells) c
  WHERE u.undo_id = ? AND u.row_id = rows.rowid AND u.ref = substr(rows.id, 1, 8) AND c.value ->> 0 = ?
    AND c.value ->> 1 NOT IN ('', '${PLACEHOLDER}') AND instr(ltrim(c.value ->> 1, ${BLANK}), '${LIST_MARK}') <> 1)`;
