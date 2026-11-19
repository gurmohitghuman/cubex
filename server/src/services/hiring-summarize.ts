// A check's summary (services/hiring-check.ts): Companies brought up to
// Roles. Roles is read into one total per company (services/hiring-roles-read.ts);
// then each Companies row, a slice at a time in a bulk writer, gets the cells
// its company's roles give it, written only where they differ (a company with
// nothing new this time has its "New" cells cleared, one with no roles left
// shows 0); then a company with no row gets one, First seen this check's day.
// Rows are matched by the company key (lib/hiring/company-key.ts) of their
// Domain and Company cells, so a row the person edited or sorted is still found.
import { db } from '../lib/db';
import { countRows, getSheetColumns, jsonPath } from '../lib/sql-helpers';
import { asBulkWriter } from '../lib/bulk-slices';
import { sheetBusyWith, nextRowIndex } from '../lib/sheet-busy';
import { markAutorunEdits } from '../lib/autorun-mark';
import { HIRING_SUMMARY_WRITE_ROWS, MAX_ROWS_PER_SHEET, SAMPLE_STEP_POLL_MS } from '../lib/constants';
import { companyKey } from '../lib/hiring/company-key';
import { COMPANY_COLUMNS } from '../lib/hiring/names';
import { companyCells, newCompanyRow, type CompanyAcc } from '../lib/hiring/summary';
import { orderedUuid } from '../lib/ordered-id';
import { bumpDataVersion } from './data-plane-shared';
import { settleEdits, settleRows } from './auto-dedupe-settle';
import { readRoles } from './hiring-roles-read';

export interface SummaryCheck { label: string; sinceLabel: string | null; runId: string | null }
export interface SummaryDone {
  roles: number; newRoles: number; companiesNew: number; companiesHiringMore: number;
  cellsWritten: number; problems: string[];
}

const SUMMARY = ['openRoles', 'titles', 'newest', 'links', 'newSince', 'newRoles'] as const;
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

async function whenFree(sheetId: string): Promise<void> {
  while (sheetBusyWith(sheetId)) await new Promise(resolve => setTimeout(resolve, SAMPLE_STEP_POLL_MS));
}

// json_set with n path/value pairs, prepared once per n.
const setters = new Map<number, ReturnType<typeof db.prepare<unknown[]>>>();
function setter(n: number) {
  let s = setters.get(n);
  if (!s) {
    s = db.prepare<unknown[]>(`UPDATE rows SET data = json_set(data${', ?, ?'.repeat(n)}), updated_at = datetime('now')
      WHERE rowid = ?`);
    setters.set(n, s);
  }
  return s;
}

// One slice: Companies rows after `after`, each brought up to its company. Answers where it got to.
function updateSlice(
  sheetId: string, userId: string, after: number, companies: Map<string, CompanyAcc>, matched: Set<string>,
  check: SummaryCheck, columns: string[], tally: { cells: number },
): { last: number; done: boolean } | 'busy' {
  if (sheetBusyWith(sheetId)) return 'busy';
  const read = db.prepare(`SELECT rowid, id, row_index, json_extract(data, ?), json_extract(data, ?)
      ${columns.map(() => ', json_extract(data, ?)').join('')}
    FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ? ORDER BY row_index LIMIT ?`).raw();
  const page = read.all(jsonPath(COMPANY_COLUMNS.domain), jsonPath(COMPANY_COLUMNS.company),
    ...columns.map(jsonPath), sheetId, userId, after, HIRING_SUMMARY_WRITE_ROWS) as unknown[][];
  const edits: Array<{ column: string; rowId: string }> = [];
  const settles: Array<{ rid: number; columns: string[] }> = [];
  const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  for (const row of page) {
    const key = companyKey(text(row[3]).trim(), text(row[4]).trim());
    if (!key) continue;   // a row the person added without a company: left alone
    const acc = companies.get(key.key) ?? null;
    if (acc) matched.add(key.key);
    const want = companyCells(acc, check);
    const pairs: unknown[] = [];
    const changed: string[] = [];
    columns.forEach((c, i) => {
      if (text(row[5 + i]) === want[c]) return;
      pairs.push(jsonPath(c), want[c]);
      changed.push(c);
    });
    if (changed.length === 0) continue;
    setter(changed.length).run(...pairs, row[0]);
    tally.cells += changed.length;
    for (const column of changed) edits.push({ column, rowId: row[1] as string });
    settles.push({ rid: row[0] as number, columns: changed });
  }
  if (edits.length) {
    markAutorunEdits(sheetId, userId, edits);
    settleEdits(sheetId, userId, settles);
    bumpDataVersion(sheetId, userId);
  }
  const done = page.length < HIRING_SUMMARY_WRITE_ROWS;
  return { last: done ? after : page[page.length - 1][2] as number, done };
}

// One slice of new company rows (the listed columns only). false: the sheet was busy.
function appendSlice(sheetId: string, userId: string, rows: Array<Record<string, string>>): boolean {
  if (sheetBusyWith(sheetId)) return false;
  let next = nextRowIndex(sheetId, userId);
  const insert = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)');
  const rids = rows.map(cells => Number(insert.run(orderedUuid(), sheetId, userId, next++, JSON.stringify(cells))
    .lastInsertRowid));
  settleRows(sheetId, userId, rids, 'arrived');
  bumpDataVersion(sheetId, userId);
  return true;
}

export async function summarizeHiring(
  userId: string, sheets: { roles: string; companies: string }, check: SummaryCheck,
): Promise<SummaryDone> {
  const read = await readRoles(userId, sheets.roles, check.runId);
  const problems: string[] = [];
  if (read.missing.length) problems.push(`Roles has no ${read.missing.map(c => `"${c}"`).join(', ')} column: `
    + 'the summary left it out.');
  if (read.byName) {
    problems.push(`${plural(read.byName, 'role')} had no domain, so ${read.byName === 1 ? 'it was' : 'they were'} `
      + 'summed up by company name.');
  }
  if (read.noCompany) problems.push(`${plural(read.noCompany, 'role')} had no company name or domain: left out.`);
  const listed = new Set(getSheetColumns(sheets.companies, userId, false));
  const columns = SUMMARY.map(k => COMPANY_COLUMNS[k]).filter(c => listed.has(c));
  const gone = SUMMARY.map(k => COMPANY_COLUMNS[k]).filter(c => !listed.has(c));
  if (gone.length) problems.push(`Companies has no ${gone.map(c => `"${c}"`).join(', ')} column: left out.`);
  const matched = new Set<string>();
  const tally = { cells: 0 };
  let added = 0;
  await asBulkWriter(async w => {
    for (let after = -1; ;) {
      await whenFree(sheets.companies);
      const r = await w.slice(() => updateSlice(sheets.companies, userId, after, read.companies, matched, check,
        columns, tally));
      if (r === 'busy') continue;
      if (r.done) break;
      after = r.last;
    }
    // Companies with no row yet, a batch at a time, in the order Roles first had them.
    const unmatched = read.companies.size - matched.size;
    const room = Math.max(0, Math.min(unmatched, MAX_ROWS_PER_SHEET - countRows(sheets.companies, userId)));
    if (room < unmatched) problems.push(`Companies is full: ${plural(unmatched - room, 'company')} weren't added.`);
    const rest = read.companies.entries();
    while (added < room) {
      const batch: Array<Record<string, string>> = [];
      while (batch.length < Math.min(HIRING_SUMMARY_WRITE_ROWS, room - added)) {
        const [key, acc] = rest.next().value as [string, CompanyAcc];
        if (matched.has(key)) continue;
        batch.push(Object.fromEntries(Object.entries(newCompanyRow(acc, check)).filter(([c]) => listed.has(c))));
      }
      for (;;) {
        await whenFree(sheets.companies);
        if (await w.slice(() => appendSlice(sheets.companies, userId, batch))) break;
      }
      added += batch.length;
    }
  });
  const more = check.sinceLabel === null ? 0
    : [...matched].filter(k => (read.companies.get(k)?.newCount ?? 0) > 0).length;
  return {
    roles: read.roles, newRoles: read.newRoles, companiesNew: added, companiesHiringMore: more,
    cellsWritten: tally.cells, problems,
  };
}
