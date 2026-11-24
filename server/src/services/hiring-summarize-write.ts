// A check's summary written on Companies (services/hiring-summarize.ts): each
// Companies row, a slice at a time in a bulk writer, gets the cells its
// company's roles give it, written only where they differ (a company with
// nothing new this time has its "New" cells cleared, one with no roles left
// shows 0); then a company with no row gets one, First seen this check's day,
// unless the table's filters on Companies keep it off (too few roles, or its
// website left out: lib/hiring/company-filters.ts). A row already there is
// kept up to date whatever the filters. Rows are matched by the company key
// (lib/hiring/company-key.ts) of their Domain and Company cells, so a row the
// person edited is still found. Given a batch, only the rows of its companies.
// Each slice first checks the sheet is out of the trash: one put there
// meanwhile gets nothing more ('gone').
import { db } from '../lib/db';
import { countRows, jsonPath, verifySheetOwnership } from '../lib/sql-helpers';
import type { BulkWriter } from '../lib/bulk-slices';
import { sheetBusyWith, nextRowIndex } from '../lib/sheet-busy';
import { markAutorunEdits } from '../lib/autorun-mark';
import { HIRING_SUMMARY_WRITE_ROWS, MAX_ROWS_PER_SHEET, SAMPLE_STEP_POLL_MS } from '../lib/constants';
import { companyKey, keyBatch } from '../lib/hiring/company-key';
import { keptOff, type CompanyKeep } from '../lib/hiring/company-filters';
import { COMPANY_COLUMNS } from '../lib/hiring/names';
import { companyCells, newCompanyRow, type CompanyAcc } from '../lib/hiring/summary';
import { orderedUuid } from '../lib/ordered-id';
import { bumpDataVersion } from './data-plane-shared';
import { settleEdits, settleRows } from './auto-dedupe-settle';
import { pacer } from './hiring-roles-read';
import { rowsChanged } from '../lib/rows-changed';

export interface SummaryCheck {
  label: string; sinceLabel: string | null; runId: string | null;
  keep?: CompanyKeep | null;                  // the table's filters on Companies (null: none)
}
export interface CompaniesTarget {
  sheetId: string; userId: string; check: SummaryCheck;
  columns: string[];                          // the summary's columns the sheet has
  listed: Set<string>;                        // every column it has (a new row fills only those)
  batch: { index: number; of: number } | null;
}
// What one write did: cells changed, companies added, companies seen before with new roles, companies not added
// (Companies full), companies the filters kept off.
export interface Written { cells: number; added: number; more: number; notAdded: number; keptOff: number }

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

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));

// One slice: Companies rows after `after`, each of the batch brought up to its company. Answers where it got to.
function updateSlice(
  t: CompaniesTarget, after: number, companies: Map<string, CompanyAcc>, matched: Set<string>, tally: Written,
): { last: number; done: boolean } | 'busy' | 'gone' {
  if (!verifySheetOwnership(t.sheetId, t.userId)) return 'gone';
  if (sheetBusyWith(t.sheetId)) return 'busy';
  const read = db.prepare(`SELECT rowid, id, row_index, json_extract(data, ?), json_extract(data, ?)
      ${t.columns.map(() => ', json_extract(data, ?)').join('')}
    FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ? ORDER BY row_index LIMIT ?`).raw();
  const page = read.all(jsonPath(COMPANY_COLUMNS.domain), jsonPath(COMPANY_COLUMNS.company),
    ...t.columns.map(jsonPath), t.sheetId, t.userId, after, HIRING_SUMMARY_WRITE_ROWS) as unknown[][];
  const edits: Array<{ column: string; rowId: string }> = [];
  const settles: Array<{ rid: number; columns: string[] }> = [];
  for (const row of page) {
    const key = companyKey(text(row[3]).trim(), text(row[4]).trim());
    if (!key) continue;   // a row the person added without a company: left alone
    if (t.batch && keyBatch(key.key, t.batch.of) !== t.batch.index) continue;
    const acc = companies.get(key.key) ?? null;
    if (acc) matched.add(key.key);
    const want = companyCells(acc, t.check);
    const pairs: unknown[] = [];
    const changed: string[] = [];
    t.columns.forEach((c, i) => {
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
    markAutorunEdits(t.sheetId, t.userId, edits);
    settleEdits(t.sheetId, t.userId, settles);
    bumpDataVersion(t.sheetId, t.userId);
  }
  const done = page.length < HIRING_SUMMARY_WRITE_ROWS;
  return { last: done ? after : page[page.length - 1][2] as number, done };
}

// One slice of new company rows (the listed columns only).
function appendSlice(t: CompaniesTarget, rows: Array<Record<string, string>>): 'done' | 'busy' | 'gone' {
  if (!verifySheetOwnership(t.sheetId, t.userId)) return 'gone';
  if (sheetBusyWith(t.sheetId)) return 'busy';
  let next = nextRowIndex(t.sheetId, t.userId);
  const insert = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)');
  const rids = rows.map(cells => Number(insert.run(orderedUuid(), t.sheetId, t.userId, next++,
    JSON.stringify(cells)).lastInsertRowid));
  rowsChanged(t.sheetId);
  settleRows(t.sheetId, t.userId, rids, 'arrived');
  bumpDataVersion(t.sheetId, t.userId);
  return 'done';
}

// The companies of one read (all of them, or a batch's) written on Companies.
export async function writeCompanies(
  w: BulkWriter, t: CompaniesTarget, companies: Map<string, CompanyAcc>,
): Promise<Written | 'gone'> {
  const tally: Written = { cells: 0, added: 0, more: 0, notAdded: 0, keptOff: 0 };
  const matched = new Set<string>();
  for (let after = -1; ;) {
    await whenFree(t.sheetId);
    const r = await w.slice(() => updateSlice(t, after, companies, matched, tally));
    if (r === 'gone') return 'gone';
    if (r === 'busy') continue;
    if (r.done) break;
    after = r.last;
  }
  const pace = pacer();
  if (t.check.sinceLabel !== null) {
    for (const k of matched) {
      if ((companies.get(k)?.newCount ?? 0) > 0) tally.more++;
      await pace();
    }
  }
  // Companies with no row yet, a slice at a time, in the order Roles first had them, but those the filters keep off.
  const keep = t.check.keep ?? null;
  const skip = (key: string, acc: CompanyAcc) => matched.has(key) || (keep !== null && keptOff(keep, acc));
  let wanted = companies.size - matched.size;
  if (keep) {
    for (const [key, acc] of companies) {
      if (!matched.has(key) && keptOff(keep, acc)) tally.keptOff++;
      await pace();
    }
    wanted -= tally.keptOff;
  }
  const room = wanted === 0 ? 0
    : Math.max(0, Math.min(wanted, MAX_ROWS_PER_SHEET - countRows(t.sheetId, t.userId)));
  tally.notAdded = wanted - room;
  const rest = companies.entries();
  while (tally.added < room) {
    const batch: Array<Record<string, string>> = [];
    while (batch.length < Math.min(HIRING_SUMMARY_WRITE_ROWS, room - tally.added)) {
      const [key, acc] = rest.next().value as [string, CompanyAcc];
      if (skip(key, acc)) { await pace(); continue; }
      batch.push(Object.fromEntries(Object.entries(newCompanyRow(acc, t.check)).filter(([c]) => t.listed.has(c))));
    }
    for (;;) {
      await whenFree(t.sheetId);
      const r = await w.slice(() => appendSlice(t, batch));
      if (r === 'gone') return 'gone';
      if (r === 'done') break;
    }
    tally.added += batch.length;
  }
  return tally;
}
