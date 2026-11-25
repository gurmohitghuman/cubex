// The input lists a run column's results were made from (run_input_sets,
// migration 066): each stamp names one, so a reader checks a row against the
// columns its own run read, never against what a newer setup reads. A list is
// made the first time a run with it stamps a row, and kept in step with
// renames of the columns it names; it goes with its key (ON DELETE CASCADE).
import { db } from '../db';
import { RUN_INPUT_SETS_READ } from '../constants';
import type { RunInputList } from './columns';

// A stamp's text: the list's id, then the fingerprint (lib/run-inputs/fingerprint.ts,
// base 36, never holding ':'). A stamp written before migration 066 has no id.
export const stampText = (setId: number, fp: string): string => `${setId}:${fp}`;

// The list's id under the key, made when none of the key's newest lists (the
// ones a reader checks) holds these columns in this order: a setup back to an
// older list gets a new one, or the rows it fills would never read out of date.
// Immediate, so two runs starting at once (each on its own connection) make
// one list; inside a caller's transaction, a savepoint.
export function ensureRunInputSet(key: number, userId: string, inputs: Readonly<RunInputList>): number {
  const columns = JSON.stringify(inputs);
  return db.transaction(() => {
    const id = db.prepare(`SELECT id FROM (SELECT id, columns FROM run_input_sets WHERE key = ? AND user_id = ?
      ORDER BY id DESC LIMIT ?) WHERE columns = ? LIMIT 1`).pluck()
      .get(key, userId, RUN_INPUT_SETS_READ, columns) as number | undefined;
    if (id !== undefined) return id;
    return Number(db.prepare('INSERT INTO run_input_sets (user_id, key, columns) VALUES (?, ?, ?)')
      .run(userId, key, columns).lastInsertRowid);
  }).immediate();
}

// The key's newest lists, newest first, each as the run wrote it.
export function runInputSets(key: number, userId: string): Array<{ id: number; inputs: RunInputList }> {
  const rows = db.prepare(`SELECT id, columns FROM run_input_sets WHERE key = ? AND user_id = ?
    ORDER BY id DESC LIMIT ?`).all(key, userId, RUN_INPUT_SETS_READ) as Array<{ id: number; columns: string }>;
  const out: Array<{ id: number; inputs: RunInputList }> = [];
  for (const r of rows) {
    try {
      const list = JSON.parse(r.columns) as unknown;
      if (Array.isArray(list)) out.push({ id: r.id, inputs: list.map(c => (typeof c === 'string' ? c : null)) });
    } catch { /* never written so: its rows read as no run stamped them */ }
  }
  return out;
}

// One list of the key by id (its legacy_set), or undefined when it's gone.
export function runInputSet(id: number, key: number, userId: string): RunInputList | undefined {
  const columns = db.prepare('SELECT columns FROM run_input_sets WHERE id = ? AND key = ? AND user_id = ?').pluck()
    .get(id, key, userId) as string | undefined;
  if (columns === undefined) return undefined;
  try {
    const list = JSON.parse(columns) as unknown;
    return Array.isArray(list) ? list.map(c => (typeof c === 'string' ? c : null)) : undefined;
  } catch { return undefined; }
}

// Inside a column rename's transaction: the lists of the sheet's run columns
// that name it name the new one (a few small rows per column, never every row).
export function renameRunInputSetColumn(sheetId: string, userId: string, oldName: string, newName: string): void {
  const sets = db.prepare(`SELECT s.id, s.columns FROM run_input_sets s
    JOIN run_input_keys k ON k.id = s.key AND k.sheet_id = ? AND k.user_id = ?
    WHERE s.user_id = ? AND EXISTS (SELECT 1 FROM json_each(s.columns) WHERE json_each.value = ?)`)
    .all(sheetId, userId, userId, oldName) as Array<{ id: number; columns: string }>;
  const update = db.prepare('UPDATE run_input_sets SET columns = ? WHERE id = ? AND user_id = ?');
  for (const s of sets) {
    const list = JSON.parse(s.columns) as RunInputList;
    update.run(JSON.stringify(list.map(c => (c === oldName ? newName : c))), s.id, userId);
  }
}
