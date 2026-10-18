// Clean data columns: one implementation for the app (routes/clean-columns.ts),
// /api/v1 and the MCP tool. A clean column is always its own column, filled
// for free from a source column by a pure cleaner (lib/clean/): no request,
// no model call. Naming an existing clean column changes it (its cleaner,
// options or source) and cleans every row again; any other existing column is
// refused, so nothing a person typed is overwritten. Starting is ONE
// transaction inside the sheet's busy window: the column joins the registry,
// its record is saved (clean_columns) and its auto-run set; the fill then runs
// in the background with the sheet still busy (clean-fill.ts).
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { appendColumnsToOrder, getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import {
  columnCollisionMessage, findColumnNameCollision, sanitizeAndValidateColumnName,
} from '../lib/column-names';
import { busyMessage, continueInBackground, sheetBusyWith, withSheetBusy } from '../lib/sheet-busy';
import { getLockedRunColumns } from '../lib/run-locked-columns';
import { cleanColumnFor, cleanLoopThrough, type CleanColumnRow } from '../lib/clean-columns';
import {
  defaultCleanColumnName, isCleaner, parseCleanOptions, unknownCleanerMessage, type CleanerId, type CleanOptions,
} from '../lib/clean/cleaners';
import { CLEANING, runCleanFill } from './clean-fill';
import { setCleanAutorun } from './derived-autorun';
import type { RunFail } from './run-shared';
import { logSheetChange } from '../lib/change-log';

export interface CleanColumnInput {
  source: unknown;
  cleaner: unknown;
  column?: unknown;      // the clean column; "<source> (<what>)" when left out
  options?: unknown;     // the cleaner's options (lib/clean/cleaners.ts)
  autoRun?: boolean;     // on for a new column; unchanged for an existing one when left out
}

// isNew: the column isn't in the sheet yet (a record can outlive its column:
// a CSV replace without it keeps the record, as auto-run's are kept).
export interface CleanSetup {
  source: string; cleaner: CleanerId; options: CleanOptions; column: string;
  existing: CleanColumnRow | undefined; isNew: boolean;
}

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

// The input, checked against the sheet as it is now. Start checks it again
// inside its transaction.
export function checkCleanInput(userId: string, sheetId: string, input: CleanColumnInput): CleanSetup | RunFail {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  if (!isCleaner(input.cleaner)) return bad(unknownCleanerMessage(input.cleaner));
  const options = parseCleanOptions(input.cleaner, input.options);
  if ('error' in options) return bad(options.error);
  if (typeof input.source !== 'string' || !input.source.trim()) return bad('Name the column to clean (source).');
  const columns = getSheetColumns(sheetId, userId, false);
  if (!columns.includes(input.source)) return bad(`There's no column named "${input.source.slice(0, 200)}".`);
  const raw = input.column === undefined || input.column === null || input.column === ''
    ? defaultCleanColumnName(input.cleaner, input.source) : input.column;
  if (typeof raw !== 'string') return bad('column must be a column name.');
  const named = sanitizeAndValidateColumnName(raw);
  if ('error' in named) return bad(named.error);
  const setup: CleanSetup = {
    source: input.source, cleaner: input.cleaner, options: options.ok, column: named.name,
    existing: cleanColumnFor(sheetId, userId, named.name), isNew: !columns.includes(named.name),
  };
  return placeProblem(sheetId, userId, setup, columns) ?? setup;
}

// Where the clean column goes: a new name (no clash, under the column cap),
// or a clean column already there; never the source, never a loop.
function placeProblem(sheetId: string, userId: string, s: CleanSetup, columns: string[]): RunFail | null {
  if (s.column === s.source) return bad('A clean column is its own column: give it a name other than its source.');
  if (!s.isNew && !s.existing) {
    return { fail: 'conflict', message: `"${s.column}" is already a column. Pick a new name for the clean column.` };
  }
  if (s.isNew) {
    const clash = findColumnNameCollision(s.column, columns);
    if (clash) return { fail: 'conflict', message: columnCollisionMessage(s.column, clash) };
    if (columns.length >= MAX_COLUMNS_PER_SHEET) {
      return {
        fail: 'cap', message: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet). Delete unused columns first.`,
      };
    }
  }
  const loop = cleanLoopThrough(sheetId, userId, s.column, s.source);
  if (loop) return bad(`${s.source} is cleaned from ${s.column} (${loop}), so ${s.column} can't be cleaned from it.`);
  if (getLockedRunColumns(sheetId, userId).has(s.column)) {
    return { fail: 'conflict', message: `A run is writing "${s.column}". Stop it first.` };
  }
  return null;
}

export type CleanStart = { ok: { id: string; column: string; created: boolean } } | RunFail;

export async function startCleanColumn(userId: string, sheetId: string, input: CleanColumnInput): Promise<CleanStart> {
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  const first = checkCleanInput(userId, sheetId, input);
  if ('fail' in first) return first;
  const out = await withSheetBusy(sheetId, CLEANING, async (): Promise<CleanStart> => {
    const result = db.transaction((): CleanStart => {
      // Again inside the write lock: the sheet may have changed since the checks.
      const s = checkCleanInput(userId, sheetId, input);
      if ('fail' in s) return s;
      const created = s.isNew;
      if (created) appendColumnsToOrder(sheetId, userId, [s.column]);
      const id = s.existing?.id ?? uuidv4();
      db.prepare(`INSERT INTO clean_columns (id, user_id, sheet_id, column_name, source_column, cleaner, options)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sheet_id, column_name) DO UPDATE SET source_column = excluded.source_column,
          cleaner = excluded.cleaner, options = excluded.options, fill_status = 'filling', fill_cursor = 0,
          filled_rows = 0, blanked_rows = 0, error_message = NULL, updated_at = datetime('now')`)
        .run(id, userId, sheetId, s.column, s.source, s.cleaner, JSON.stringify(s.options));
      setCleanAutorun(sheetId, userId, s.column, s.source, input.autoRun ?? (created ? true : undefined));
      db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
        WHERE id = ? AND user_id = ?`).run(sheetId, userId);
      logSheetChange(sheetId, userId, 'clean_column',
        `${created ? 'Added' : 'Changed'} the clean column "${s.column}" (${s.cleaner} of "${s.source}")`,
        { column: s.column, detail: { source: s.source, cleaner: s.cleaner, options: s.options } });
      return { ok: { id, column: s.column, created } };
    }).immediate();
    if ('ok' in result) continueInBackground(sheetId, CLEANING, () => runCleanFill(result.ok.id));
    return result;
  });
  return 'busy' in out && typeof out.busy === 'string' ? { fail: 'conflict', message: out.busy } : out as CleanStart;
}

// Auto-run on or off for a clean column (the column menu, MCP set_auto_run).
// Turning it on (from off) cleans every row again first: rows whose source
// changed while it was off would otherwise keep their old values. It has no
// rule or caps.
export async function setCleanColumnAutorun(
  userId: string, sheetId: string, rec: CleanColumnRow, enabled: boolean,
): Promise<{ ok: { column: string } } | RunFail> {
  if (!enabled) {
    db.transaction(() => setCleanAutorun(sheetId, userId, rec.column_name, rec.source_column, false)).immediate();
    return { ok: { column: rec.column_name } };
  }
  // Already on: turning it on lifts a pause, as for any auto-run.
  const on = db.prepare(`UPDATE autorun_columns SET paused_reason = NULL, paused_message = NULL, paused_at = NULL,
      rescan = 1, updated_at = datetime('now')
    WHERE sheet_id = ? AND user_id = ? AND status_column = ? AND enabled = 1`)
    .run(sheetId, userId, rec.column_name).changes > 0;
  if (on) return { ok: { column: rec.column_name } };
  let options: unknown = {};
  try { options = JSON.parse(rec.options); } catch { /* defaults */ }
  const started = await startCleanColumn(userId, sheetId, {
    source: rec.source_column, cleaner: rec.cleaner, column: rec.column_name, options, autoRun: true,
  });
  return 'fail' in started ? started : { ok: { column: rec.column_name } };
}
