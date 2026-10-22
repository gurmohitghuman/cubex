// Where a list enrichment's results go: a sheet of the same table (never the
// source itself), or a new one the run start makes. The columns its rows fill
// (the fields kept and the columns copied from the source row) are checked
// here: a name that matches a destination column (any case) writes into it,
// unless a run or a webhook owns that column; the rest are new columns.
// planListDest only reads; applyListDest runs inside the start transaction.
import { db } from '../lib/db';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { getSheetColumns, appendColumnsToOrder } from '../lib/sql-helpers';
import { getColumnTypes } from '../lib/column-types';
import {
  columnCollisionMessage, findColumnNameCollision, sanitizeAndValidateColumnName,
} from '../lib/column-names';
import { validateSheetName } from '../lib/sheet-validation';
import { normalizeNameSpacing } from '../lib/name-safety';
import { createSheetTxn, sheetNameTaken } from '../lib/sheet-crud-helpers';
import { busyMessage, sheetBusyWith } from '../lib/sheet-busy';
import type { ListInput } from '../lib/enrich-list-input';
import type { ListCopy, ListField } from '../lib/enrich-list';
import type { RunFail } from './run-shared';

export interface DestPlan {
  tableId: string;
  sheetId: string | null;       // null: a new sheet named newName
  newName: string | null;
  name: string;                 // the sheet's name, for messages and cells
  fields: ListField[] | null;   // column names as they are (or will be) in the sheet
  copy: ListCopy[];
  newColumns: string[];
}

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const nameTaken = (name: string) => `A sheet named "${name}" already exists. Pick another name, or pick that sheet.`;
// Columns a list may write into: plain ones, and ones a webhook mapping fills.
const WRITABLE = new Set(['webhook-mapped']);

// The columns the rows fill, by name as the sheet has them.
export function destColumns(
  input: Pick<ListInput, 'copy' | 'fields'>, have: string[], types: Record<string, string>, destName: string,
): { fields: ListField[] | null; copy: ListCopy[]; newColumns: string[] } | RunFail {
  const wanted = [
    ...input.copy.map(c => c.to), ...(input.fields ?? []).map(f => f.columnName),
  ];
  const names: string[] = [];
  for (const raw of wanted) {
    const v = sanitizeAndValidateColumnName(raw);
    if ('error' in v) return bad(`"${raw.slice(0, 60)}": ${v.error}`);
    const clash = findColumnNameCollision(v.name, names);
    if (clash) return bad(`Two columns of ${destName} would clash: ${columnCollisionMessage(v.name, clash)}`);
    let name = v.name;
    const there = findColumnNameCollision(v.name, have);
    if (there && there.kind !== 'token') name = there.clash;
    else if (there) return bad(`${destName}: ${columnCollisionMessage(v.name, there)}`);
    const type = types[name];
    if (type && !WRITABLE.has(type)) {
      return bad(`"${name}" in ${destName} is filled by a run or a webhook. Pick another name.`);
    }
    names.push(name);
  }
  const copy = input.copy.map((c, i) => ({
    id: `c${i + 1}`, from: c.from, to: names[i], ...(c.value !== undefined ? { value: c.value } : {}),
  }));
  const fields = input.fields
    ? input.fields.map((f, i) => ({ path: f.path, columnName: names[input.copy.length + i] })) : null;
  const newColumns = names.filter(n => !have.includes(n));
  if (have.length + newColumns.length > MAX_COLUMNS_PER_SHEET) {
    return bad(`${destName} would pass the column limit (${MAX_COLUMNS_PER_SHEET} per sheet). Keep fewer fields.`);
  }
  return { fields, copy, newColumns };
}

export function planListDest(
  userId: string, sourceSheetId: string, input: ListInput, sourceColumns: string[],
): { ok: DestPlan } | RunFail {
  const source = db.prepare('SELECT table_id FROM sheets WHERE id = ? AND user_id = ?')
    .get(sourceSheetId, userId) as { table_id: string } | undefined;
  if (!source) return { fail: 'not_found', message: 'Sheet not found' };
  const gone = input.copy.find(c => c.value === undefined && !sourceColumns.includes(c.from));
  if (gone) return bad(`The column "${gone.from}" isn't in this sheet anymore.`);
  let sheetId: string | null = null, newName: string | null = null, name: string;
  let have: string[] = [], types: Record<string, string> = {};
  if ('sheetId' in input.dest) {
    const dest = db.prepare('SELECT id, name, table_id FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL')
      .get(input.dest.sheetId, userId) as { id: string; name: string; table_id: string } | undefined;
    if (!dest) return bad('The sheet for the results was deleted. Pick another sheet.');
    if (dest.id === sourceSheetId) return bad('Pick another sheet for the results: rows here would run again.');
    if (dest.table_id !== source.table_id) return bad('Pick a sheet of this table for the results.');
    const busy = sheetBusyWith(dest.id);
    if (busy) return { fail: 'conflict', message: `${dest.name}: ${busyMessage(busy)}` };
    sheetId = dest.id; name = dest.name;
    have = getSheetColumns(dest.id, userId, false);
    types = getColumnTypes(dest.id, userId);
  } else {
    const err = validateSheetName(input.dest.newSheetName);
    if (err) return { ...bad(err), field: 'destName' };
    newName = normalizeNameSpacing(input.dest.newSheetName);
    if (sheetNameTaken(source.table_id, userId, newName)) {
      return { fail: 'conflict', message: nameTaken(newName), field: 'destName' };
    }
    name = newName;
  }
  const cols = destColumns(input, have, types, name);
  if ('fail' in cols) return cols;
  return { ok: { tableId: source.table_id, sheetId, newName, name, ...cols } };
}

// Inside a start transaction, for an existing destination: why the plan no
// longer holds, or null. A sort, an import or a column change there now (a
// rename rewrites the runs into it a page at a time, newest first, so a run
// inserted mid-way would keep the old name), or a column the rows fill that
// it had then, renamed or deleted since (its rows would bring it back).
export function destMoved(
  userId: string, destId: string, name: string, fills: { fields: ListField[] | null; copy: ListCopy[] },
  newColumns: string[],
): string | null {
  const busy = sheetBusyWith(destId);
  if (busy) return `${name}: ${busyMessage(busy)}`;
  const have = new Set(getSheetColumns(destId, userId, false));
  const gone = [...fills.copy.map(c => c.to), ...(fills.fields ?? []).map(f => f.columnName)]
    .find(c => !have.has(c) && !newColumns.includes(c));
  return gone === undefined ? null : `The columns of ${name} changed meanwhile. Try again.`;
}

// Inside the start transaction: the new sheet (no starter rows), and the
// columns the rows fill. raced: the name was taken, the sheet changed, or the
// columns no longer fit, since planListDest read them (the caller rolls back).
export function applyListDest(
  userId: string, sourceSheetId: string, plan: DestPlan,
): { sheetId: string } | { raced: string; field?: 'destName' } {
  let sheetId = plan.sheetId;
  const moved = sheetId ? destMoved(userId, sheetId, plan.name, plan, plan.newColumns) : null;
  if (moved) return { raced: moved };
  if (!sheetId) {
    const made = createSheetTxn(plan.tableId, userId, plan.newName!, sourceSheetId, { seed: false });
    if (!made.ok) return { raced: nameTaken(plan.newName!), field: 'destName' };
    sheetId = made.sheetId;
  }
  const have = getSheetColumns(sheetId, userId, false);
  const add = plan.newColumns.filter(c => !have.includes(c));
  if (have.length + add.length > MAX_COLUMNS_PER_SHEET) {
    const limit = `${MAX_COLUMNS_PER_SHEET} per sheet`;
    return { raced: `${plan.name} would pass the column limit (${limit}). Keep fewer fields.` };
  }
  appendColumnsToOrder(sheetId, userId, add);
  return { sheetId };
}
