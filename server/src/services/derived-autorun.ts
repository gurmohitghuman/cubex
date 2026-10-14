// A clean or formula column's auto-run entry (autorun_columns, kind 'clean' or
// 'formula'): it reads the column's inputs and follows them (derived-follow.ts).
// Call inside the transaction that saves the column, which starts a fill: the
// fill covers the rows there now, so the entry's fence starts above them.
// enabled: true turns it on (lifting any pause), false off, undefined keeps
// it as it is (and points an existing entry at the new inputs). Saving the
// column again also lifts a stop of its own ('setup', 'too_slow'): the setup
// that stopped it is gone.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import type { DerivedKindId } from './derived-kind';

export function setDerivedAutorun(
  kind: DerivedKindId, sheetId: string, userId: string, column: string, inputs: string[],
  enabled: boolean | undefined,
): void {
  const prior = db.prepare(`SELECT id, enabled FROM autorun_columns
    WHERE sheet_id = ? AND user_id = ? AND status_column = ?`)
    .get(sheetId, userId, column) as { id: string; enabled: number } | undefined;
  if (enabled === false) {
    if (prior) {
      db.prepare(`UPDATE autorun_columns SET enabled = 0, paused_reason = NULL, paused_message = NULL,
        paused_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(prior.id);
    }
    return;
  }
  if (enabled === undefined && !prior) return;
  const top = db.prepare('SELECT IFNULL(MAX(row_index), -1) FROM rows WHERE sheet_id = ? AND user_id = ?')
    .pluck().get(sheetId, userId) as number;
  const gen = db.prepare('SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?')
    .pluck().get(sheetId, userId) as number;
  const on = enabled === true ? 1 : prior!.enabled;
  db.prepare(`INSERT INTO autorun_columns (id, user_id, sheet_id, status_column, kind, enabled, input_columns,
      watermark_row_index, rescan, row_generation_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(sheet_id, status_column) DO UPDATE SET kind = excluded.kind, enabled = excluded.enabled,
      input_columns = excluded.input_columns, where_json = NULL, run_if = NULL, daily_cap_micro = NULL,
      daily_row_cap = NULL, watermark_row_index = excluded.watermark_row_index, rescan = 1,
      row_generation_seen = excluded.row_generation_seen, updated_at = datetime('now'),
      paused_reason = CASE WHEN ? OR paused_reason IN ('setup', 'too_slow') THEN NULL ELSE paused_reason END,
      paused_message = CASE WHEN ? OR paused_reason IN ('setup', 'too_slow') THEN NULL ELSE paused_message END,
      paused_at = CASE WHEN ? OR paused_reason IN ('setup', 'too_slow') THEN NULL ELSE paused_at END`)
    .run(prior?.id ?? uuidv4(), userId, sheetId, column, kind, on, JSON.stringify(inputs), top, gen,
      ...Array(3).fill(enabled === true ? 1 : 0));
}

// A clean column reads its source.
export const setCleanAutorun = (
  sheetId: string, userId: string, column: string, source: string, enabled: boolean | undefined,
): void => setDerivedAutorun('clean', sheetId, userId, column, [source], enabled);
