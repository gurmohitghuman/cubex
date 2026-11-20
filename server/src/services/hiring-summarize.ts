// A check's summary (services/hiring-check-watch.ts): Companies brought up to
// Roles. Both sheets are held for reading meanwhile (lib/sheet-busy.ts), so no
// sort or import moves their rows under the walks; cell edits go on. Roles is
// read into one total per company (services/hiring-roles-read.ts), then
// Companies is written from them (services/hiring-summarize-write.ts). Past
// HIRING_SUMMARY_MAX_COMPANIES companies, the companies go in batches by a
// hash of their key: Roles read once per batch, each read keeping only its
// batch's totals (a batch that still grows too big splits in two), so memory
// stays bounded. A sheet put in the trash meanwhile stops it ({ gone }).
import { getSheetColumns } from '../lib/sql-helpers';
import { asBulkWriter } from '../lib/bulk-slices';
import { withSheetRead } from '../lib/sheet-busy';
import { HIRING_SUMMARY_BATCH_SLACK, HIRING_SUMMARY_MAX_COMPANIES, SAMPLE_STEP_POLL_MS } from '../lib/constants';
import { COMPANY_COLUMNS } from '../lib/hiring/names';
import { nameRemap, readRoles, type RolesRead } from './hiring-roles-read';
import { writeCompanies, type CompaniesTarget, type SummaryCheck, type Written } from './hiring-summarize-write';

export type { SummaryCheck } from './hiring-summarize-write';
export interface SummaryDone {
  roles: number; newRoles: number; companiesNew: number; companiesHiringMore: number;
  cellsWritten: number; problems: string[];
}
export interface SummaryOpts { maxCompanies?: number }   // tests: a smaller most, to see the batches

const SUMMARY = ['openRoles', 'titles', 'newest', 'links', 'newSince', 'newRoles'] as const;
const HOLD = 'summing up the roles per company';
const GONE = { gone: true } as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

// Holds Roles and Companies for reading while `work` runs, once neither is busy.
async function holdingBoth<T extends object>(roles: string, companies: string, work: () => Promise<T>): Promise<T> {
  for (;;) {
    const out = await withSheetRead(roles, () => withSheetRead(companies, work, HOLD), HOLD);
    if (!('busy' in out)) return out as T;
    await new Promise(resolve => setTimeout(resolve, SAMPLE_STEP_POLL_MS));
  }
}

function problemsOf(read: RolesRead, gone: string[], notAdded: number): string[] {
  const problems: string[] = [];
  if (read.missing.length) problems.push(`Roles has no ${read.missing.map(c => `"${c}"`).join(', ')} column: `
    + 'the summary left it out.');
  if (read.byName) {
    problems.push(`${plural(read.byName, 'role')} had no domain, so ${read.byName === 1 ? 'it was' : 'they were'} `
      + 'summed up by company name.');
  }
  if (read.noCompany) problems.push(`${plural(read.noCompany, 'role')} had no company name or domain: left out.`);
  if (read.newNoKey) {
    const them = read.newNoKey === 1 ? 'it' : 'them';
    problems.push(`${plural(read.newNoKey, 'new role')} had no link or job id to tell ${them} apart, so a later `
      + `check can add ${them} again.`);
  }
  if (gone.length) problems.push(`Companies has no ${gone.map(c => `"${c}"`).join(', ')} column: left out.`);
  if (notAdded > 0) {
    problems.push(`Companies is full: ${plural(notAdded, 'company', 'companies')} `
      + `${notAdded === 1 ? "wasn't" : "weren't"} added.`);
  }
  return problems;
}

export async function summarizeHiring(
  userId: string, sheets: { roles: string; companies: string }, check: SummaryCheck, opts: SummaryOpts = {},
): Promise<SummaryDone | typeof GONE> {
  return holdingBoth(sheets.roles, sheets.companies, () => summarize(userId, sheets, check, opts));
}

async function summarize(
  userId: string, sheets: { roles: string; companies: string }, check: SummaryCheck, opts: SummaryOpts,
): Promise<SummaryDone | typeof GONE> {
  const cap = opts.maxCompanies ?? HIRING_SUMMARY_MAX_COMPANIES;
  const listed = new Set(getSheetColumns(sheets.companies, userId, false));
  const target = (batch: CompaniesTarget['batch']): CompaniesTarget => ({
    sheetId: sheets.companies, userId, check, listed, batch,
    columns: SUMMARY.map(k => COMPANY_COLUMNS[k]).filter(c => listed.has(c)),
  });
  const total: Written = { cells: 0, added: 0, more: 0, notAdded: 0 };
  const sum = (w: Written) => { for (const k of Object.keys(total) as Array<keyof Written>) total[k] += w[k]; };
  const first = await readRoles(userId, sheets.roles, check.runId, { batch: null, cap });
  if ('gone' in first) return GONE;
  // The read whose counts the problems use (every whole read counts every role), or null: a sheet went.
  const read = await asBulkWriter(async (w): Promise<RolesRead | null> => {
    if (!('overflow' in first)) {
      const out = await writeCompanies(w, target(null), first.companies);
      if (out === 'gone') return null;
      sum(out);
      return first;
    }
    const remap = await nameRemap(userId, sheets.roles);
    if (remap === 'gone') return null;
    let stats: RolesRead | null = null;
    // As many batches as keep about `cap` companies each, from the count the first read made.
    const of = Math.max(2, Math.ceil(first.overflow / cap));
    const queue = Array.from({ length: of }, (_, index) => ({ index, of }));
    for (let b = queue.shift(); b; b = queue.shift()) {
      const part = await readRoles(userId, sheets.roles, check.runId,
        { batch: { ...b, remap }, cap: cap * HIRING_SUMMARY_BATCH_SLACK });
      if ('gone' in part) return null;
      // Still too big (the hash put more in it): its keys split between two batches of twice as many.
      if ('overflow' in part) {
        queue.push({ index: b.index, of: b.of * 2 }, { index: b.index + b.of, of: b.of * 2 });
        continue;
      }
      const out = await writeCompanies(w, target(b), part.companies);
      if (out === 'gone') return null;
      sum(out);
      // Its counts only: the next batch's read never holds this one's companies too.
      stats = { ...part, companies: new Map() };
    }
    return stats;
  });
  if (!read) return GONE;
  const gone = SUMMARY.map(k => COMPANY_COLUMNS[k]).filter(c => !listed.has(c));
  return {
    roles: read.roles, newRoles: read.newRoles, companiesNew: total.added, companiesHiringMore: total.more,
    cellsWritten: total.cells, problems: problemsOf(read, gone, total.notAdded),
  };
}
