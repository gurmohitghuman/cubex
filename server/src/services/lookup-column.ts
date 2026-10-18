// Lookup columns: one implementation for the app (routes/sheets-lookup.ts),
// /api/v1 and the MCP tool. A lookup column is always its own column, filled
// for free from another sheet: per row, the value of source_column is matched
// against match_column there (equals, or contains), and the column gets a
// column of the first match, yes/no, a count, or the matches as a JSON list.
// Naming an existing lookup column changes it and looks every row up again;
// any other existing column is refused. Starting is ONE transaction inside the
// sheet's busy window: the column joins the registry, its record and the other
// column's source are saved (which turns the triggers on there) and its
// auto-run set; the fill then runs in the background.
// Over 200 lines: the input check covers both sheets, and start re-runs it inside its transaction.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { LOOKUP_LIST_DEFAULT, LOOKUP_LIST_MAX, MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { appendColumnsToOrder, getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import {
  columnCollisionMessage, findColumnNameCollision, sanitizeAndValidateColumnName,
} from '../lib/column-names';
import { busyMessage, continueInBackground, sheetBusyWith, withSheetBusy } from '../lib/sheet-busy';
import { getLockedRunColumns } from '../lib/run-locked-columns';
import { derivedLoopThrough } from '../lib/derived-loops';
import {
  lookupColumnFor, type LookupColumnRow, type LookupMatch, type LookupReturns,
} from '../lib/lookup-columns';
import { runDerivedFill } from './derived-fill';
import { setDerivedAutorun } from './derived-autorun';
import { LOOKUP_FILLING, lookupKind, readsFilling } from './lookup-kind';
import { ensureLookupSource, releaseLookupSource } from './lookup-source';
import type { RunFail } from './run-shared';
import { logSheetChange } from '../lib/change-log';

export interface LookupColumnInput {
  column?: unknown;         // the lookup column's name (a preview can leave it out)
  sourceColumn?: unknown;   // this sheet's column holding the value to look up
  otherSheetId?: unknown;   // the sheet it looks in
  matchColumn?: unknown;    // the column there it matches
  match?: unknown;          // 'equals' (default) or 'contains'
  returns?: unknown;        // 'value', 'exists', 'count' or 'list'
  returnColumn?: unknown;   // 'value': the column there to write
  returnColumns?: unknown;  // 'list': the columns there each match carries (left out: all)
  limit?: unknown;          // 'list': at most this many matches (1-100)
  autoRun?: boolean;        // on for a new column; unchanged for an existing one when left out
}

// isNew: the column isn't in the sheet yet (a record can outlive its column).
export interface LookupSetup {
  column: string | null; source: string; otherSheetId: string; otherName: string; matchColumn: string;
  match: LookupMatch; returns: LookupReturns; returnColumns: string[] | null; limit: number;
  existing: LookupColumnRow | undefined; isNew: boolean;
}

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const RETURNS: LookupReturns[] = ['value', 'exists', 'count', 'list'];

function otherSide(
  userId: string, sheetId: string, input: LookupColumnInput,
): { otherSheetId: string; otherName: string; columns: string[] } | RunFail {
  if (typeof input.otherSheetId !== 'string' || !input.otherSheetId) return bad('Pick the sheet to look in.');
  const other = db.prepare('SELECT id, name FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL')
    .get(input.otherSheetId, userId) as { id: string; name: string } | undefined;
  if (!other) return { fail: 'not_found', message: "The sheet to look in wasn't found." };
  if (other.id === sheetId) return bad('Pick another sheet: a lookup reads a different sheet than its own.');
  return { otherSheetId: other.id, otherName: other.name, columns: getSheetColumns(other.id, userId, false) };
}

// What it returns, checked against the other sheet's columns.
function returnsOf(
  input: LookupColumnInput, otherName: string, columns: string[],
): { returns: LookupReturns; returnColumns: string[] | null; limit: number } | RunFail {
  const returns = input.returns as LookupReturns;
  if (!RETURNS.includes(returns)) return bad('returns must be "value", "exists", "count" or "list".');
  const missing = (c: unknown) => typeof c !== 'string' || !columns.includes(c);
  if (returns === 'value') {
    if (missing(input.returnColumn)) return bad(`Pick the column of "${otherName}" to write (returnColumn).`);
    return { returns, returnColumns: [input.returnColumn as string], limit: 1 };
  }
  if (returns !== 'list') return { returns, returnColumns: null, limit: 1 };
  let limit = LOOKUP_LIST_DEFAULT;
  if (input.limit !== undefined && input.limit !== null) {
    if (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > LOOKUP_LIST_MAX) {
      return bad(`limit must be a whole number from 1 to ${LOOKUP_LIST_MAX}.`);
    }
    limit = input.limit as number;
  }
  if (input.returnColumns === undefined || input.returnColumns === null) return { returns, returnColumns: null, limit };
  if (!Array.isArray(input.returnColumns) || input.returnColumns.length === 0) {
    return bad('returnColumns must list one or more columns, or be left out for all of them.');
  }
  const gone = input.returnColumns.find(missing);
  if (gone !== undefined) return bad(`"${String(gone)}" isn't a column of "${otherName}".`);
  return { returns, returnColumns: [...new Set(input.returnColumns as string[])], limit };
}

// The input, checked against both sheets as they are now (start checks it
// again inside its transaction). A preview may leave the column out.
export function checkLookupInput(
  userId: string, sheetId: string, input: LookupColumnInput, opts: { needColumn?: boolean } = {},
): LookupSetup | RunFail {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const columns = getSheetColumns(sheetId, userId, false);
  if (typeof input.sourceColumn !== 'string' || !columns.includes(input.sourceColumn)) {
    return bad('Pick the column of this sheet holding the value to look up (sourceColumn).');
  }
  const other = otherSide(userId, sheetId, input);
  if ('fail' in other) return other;
  if (typeof input.matchColumn !== 'string' || !other.columns.includes(input.matchColumn)) {
    return bad(`Pick the column of "${other.otherName}" to match (matchColumn).`);
  }
  const match = (input.match ?? 'equals') as LookupMatch;
  if (match !== 'equals' && match !== 'contains') return bad('match must be "equals" or "contains".');
  const ret = returnsOf(input, other.otherName, other.columns);
  if ('fail' in ret) return ret;
  const base = {
    source: input.sourceColumn, otherSheetId: other.otherSheetId, otherName: other.otherName,
    matchColumn: input.matchColumn, match, ...ret,
  };
  const empty = input.column === undefined || input.column === null || input.column === '';
  if (empty) {
    if (opts.needColumn !== false) return bad('Name the lookup column (column).');
    return { ...base, column: null, existing: undefined, isNew: true };
  }
  if (typeof input.column !== 'string') return bad('column must be a column name.');
  const named = sanitizeAndValidateColumnName(input.column);
  if ('error' in named) return bad(named.error);
  const setup: LookupSetup = {
    ...base, column: named.name, existing: lookupColumnFor(sheetId, userId, named.name),
    isNew: !columns.includes(named.name),
  };
  return placeProblem(sheetId, userId, setup, columns) ?? setup;
}

// Where the lookup column goes: a new name (no clash, under the column cap),
// or a lookup column already there; never the column it reads, never a loop.
function placeProblem(sheetId: string, userId: string, s: LookupSetup, columns: string[]): RunFail | null {
  const column = s.column!;
  if (!s.isNew && !s.existing) {
    return { fail: 'conflict', message: `"${column}" is already a column. Pick a new name for the lookup column.` };
  }
  if (s.isNew) {
    const clash = findColumnNameCollision(column, columns);
    if (clash) return { fail: 'conflict', message: columnCollisionMessage(column, clash) };
    if (columns.length >= MAX_COLUMNS_PER_SHEET) {
      return {
        fail: 'cap', message: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet). Delete unused columns first.`,
      };
    }
  }
  if (s.source === column) return bad(`A lookup can't read its own column, "${column}".`);
  const loop = derivedLoopThrough(sheetId, userId, column, [s.source]);
  if (loop) return bad(`The lookup can't read ${loop}: that is worked out from "${column}" itself.`);
  if (getLockedRunColumns(sheetId, userId).has(column)) {
    return { fail: 'conflict', message: `A run is writing "${column}". Stop it first.` };
  }
  return null;
}

// A column it reads in the other sheet that a run or a fill is writing now.
function otherStillFilling(userId: string, sheetId: string, s: LookupSetup): RunFail | null {
  const filling = readsFilling({
    user_id: userId, sheet_id: sheetId, other_sheet_id: s.otherSheetId, match_column: s.matchColumn,
    return_columns: s.returnColumns ? JSON.stringify(s.returnColumns) : null,
  } as LookupColumnRow);
  if (!filling) return null;
  return {
    fail: 'conflict',
    message: `"${filling.column}" in "${s.otherName}" is still being filled. Look up once it's done.`,
  };
}

export type LookupStart = { ok: { id: string; column: string; created: boolean } } | RunFail;

export async function startLookupColumn(
  userId: string, sheetId: string, input: LookupColumnInput,
): Promise<LookupStart> {
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  const first = checkLookupInput(userId, sheetId, input);
  if ('fail' in first) return first;
  const filling = otherStillFilling(userId, sheetId, first);
  if (filling) return filling;
  const out = await withSheetBusy(sheetId, LOOKUP_FILLING, async (): Promise<LookupStart> => {
    const result = db.transaction((): LookupStart => {
      // Again inside the write lock: either sheet may have changed since the checks.
      const s = checkLookupInput(userId, sheetId, input);
      if ('fail' in s) return s;
      const stillFilling = otherStillFilling(userId, sheetId, s);
      if (stillFilling) return stillFilling;
      const column = s.column!;
      const created = s.isNew;
      if (created) appendColumnsToOrder(sheetId, userId, [column]);
      const id = s.existing?.id ?? uuidv4();
      db.prepare(`INSERT INTO lookup_columns (id, user_id, sheet_id, column_name, source_column, other_sheet_id,
          match_column, match_mode, returns, return_columns, list_limit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sheet_id, column_name) DO UPDATE SET source_column = excluded.source_column,
          other_sheet_id = excluded.other_sheet_id, match_column = excluded.match_column,
          match_mode = excluded.match_mode, returns = excluded.returns, return_columns = excluded.return_columns,
          list_limit = excluded.list_limit, broken = NULL, fill_status = 'filling', fill_cursor = 0,
          filled_rows = 0, error_rows = 0, first_error = NULL, error_message = NULL, updated_at = datetime('now')`)
        .run(id, userId, sheetId, column, s.source, s.otherSheetId, s.matchColumn, s.match, s.returns,
          s.returnColumns ? JSON.stringify(s.returnColumns) : null, s.limit);
      ensureLookupSource(userId, s.otherSheetId, s.matchColumn, s.match === 'contains');
      const prior = s.existing;
      if (prior && (prior.other_sheet_id !== s.otherSheetId || prior.match_column !== s.matchColumn)) {
        releaseLookupSource(userId, prior.other_sheet_id, prior.match_column);
      }
      setDerivedAutorun('lookup', sheetId, userId, column, [s.source], input.autoRun ?? (created ? true : undefined));
      db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
        WHERE id = ? AND user_id = ?`).run(sheetId, userId);
      logSheetChange(sheetId, userId, 'lookup_column', `${created ? 'Added' : 'Changed'} the lookup column "${column}"`,
        { column, detail: {
          source_column: s.source, other_sheet_id: s.otherSheetId, match_column: s.matchColumn, match: s.match,
          returns: s.returns,
        } });
      return { ok: { id, column, created } };
    }).immediate();
    if ('ok' in result) continueInBackground(sheetId, LOOKUP_FILLING, () => runDerivedFill(lookupKind, result.ok.id));
    return result;
  });
  return 'busy' in out && typeof out.busy === 'string' ? { fail: 'conflict', message: out.busy } : out as LookupStart;
}

// The stored setup as start's input (look every row up again, turn auto-run back on).
export function lookupInputOf(rec: LookupColumnRow, autoRun?: boolean): LookupColumnInput {
  const returnColumns = rec.return_columns === null ? null : JSON.parse(rec.return_columns) as string[];
  return {
    column: rec.column_name, sourceColumn: rec.source_column, otherSheetId: rec.other_sheet_id,
    matchColumn: rec.match_column, match: rec.match_mode, returns: rec.returns,
    returnColumn: rec.returns === 'value' ? returnColumns?.[0] : undefined,
    returnColumns: rec.returns === 'list' ? returnColumns : undefined, limit: rec.list_limit, autoRun,
  };
}

// Auto-run on or off (the column menu, MCP set_auto_run). Turning it on (from
// off) looks every row up again first; turning it on while it's on lifts a
// pause. It has no rule or caps.
export async function setLookupColumnAutorun(
  userId: string, sheetId: string, rec: LookupColumnRow, enabled: boolean,
): Promise<{ ok: { column: string } } | RunFail> {
  if (!enabled) {
    db.transaction(() => setDerivedAutorun('lookup', sheetId, userId, rec.column_name, [], false)).immediate();
    return { ok: { column: rec.column_name } };
  }
  if (rec.broken) return { fail: 'conflict', message: `${rec.broken} Set the lookup up again first.` };
  const on = db.prepare(`UPDATE autorun_columns SET paused_reason = NULL, paused_message = NULL, paused_at = NULL,
      rescan = 1, updated_at = datetime('now')
    WHERE sheet_id = ? AND user_id = ? AND status_column = ? AND enabled = 1`)
    .run(sheetId, userId, rec.column_name).changes > 0;
  if (on) return { ok: { column: rec.column_name } };
  const started = await startLookupColumn(userId, sheetId, lookupInputOf(rec, true));
  return 'fail' in started ? started : { ok: { column: rec.column_name } };
}
