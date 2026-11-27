// "Find buyers" on a hiring table (plans/find-jobs-buyer.md): the person each company in Companies would buy through,
// found by job title, with a verified work email (the columns' setups: lib/hiring/buyer.ts). The first time, the two
// enrichment columns are saved on Companies, not run, as the enrichment drawer's Save does (startEnrichmentRun with
// saveOnly: every check a start makes, the treg key included); new titles save the people search's setup again, its
// cells kept. Then both run as one column run (services/column-run.ts): priced first, the email after the search it
// reads, under a ceiling (max_cost_usd) the whole run stays within. One implementation for the app, /api/v1 and MCP.
import { getSheetColumns } from '../lib/sql-helpers';
import { inputTemplates } from '../lib/enrich-run-config';
import { BUYER_COLUMNS } from '../lib/hiring/names';
import { BUYER_TOOL_ID, buyerEmailInput, buyerSearchInput, buyerTitlesFor, titlesOfInput } from '../lib/hiring/buyer';
import { newestColumnRun } from './enrich-column';
import { getTool } from './enrich-catalog';
import { startEnrichmentRun } from './enrich-run-start';
import { runColumns, type ColumnRunOutcome } from './column-run';
import type { HiringRecord } from './hiring-store';
import type { RunFail } from './run-shared';

// added: the people search's column is on Companies; titles: the titles it searches (none until added);
// starting: the titles "Find buyers" starts with for this table's roles (lib/hiring/buyer.ts).
export interface BuyerView { added: boolean; titles: string[]; starting: string[] }

const rolesOf = (rec: HiringRecord): string[] => {
  try {
    const v = JSON.parse(rec.roles);
    return Array.isArray(v) ? v.filter((r): r is string => typeof r === 'string') : [];
  } catch { return []; }
};

function searchRun(userId: string, rec: HiringRecord) {
  const sheet = rec.companies_sheet_id;
  const run = newestColumnRun(sheet, userId, BUYER_COLUMNS.search);
  return run && getSheetColumns(sheet, userId, false).includes(BUYER_COLUMNS.search) ? run : null;
}

export function buyerOf(userId: string, rec: HiringRecord): BuyerView {
  const run = searchRun(userId, rec);
  return {
    added: !!run, titles: run ? titlesOfInput(inputTemplates(run.config)) ?? [] : [],
    starting: buyerTitlesFor(rolesOf(rec)),
  };
}

export type BuyerRows = 'empty' | 'all';
// canSave: the caller may save column setups (an access token with the write scope); without it, a call that would
// save one is refused before anything changes.
export interface FindBuyersOpts {
  titles: string[] | null; rows: BuyerRows; estimateOnly: boolean; maxCostUsd: number | null; canSave?: boolean;
}
type ColumnRunOk = Extract<ColumnRunOutcome, { ok: unknown }>['ok'];
type ColumnRunFail = Exclude<ColumnRunOutcome, { ok: unknown }>;
// saved: the columns whose setup this call saved (their main columns); added: the columns it added to Companies;
// titles: the titles the search uses.
export type FindBuyersOutcome =
  | { ok: ColumnRunOk & { saved: string[]; added: string[]; titles: string[] } } | ColumnRunFail;

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((t, i) => t.toLowerCase() === b[i].toLowerCase());

// The columns a setup would add that a person has made or kept themselves (a deleted search column leaves its
// outputs): named, so the person can rename or delete them first.
function inTheWay(userId: string, sheetId: string, columns: string[]): string | null {
  const there = new Set(getSheetColumns(sheetId, userId, false));
  const taken = columns.filter(c => there.has(c));
  return taken.length ? `Companies already has ${taken.map(c => `"${c}"`).join(', ')}: rename or delete `
    + `${taken.length === 1 ? 'it' : 'them'}, then find buyers again.` : null;
}

// Saves what is missing or changed (free), then the column run: its estimate, or the run under maxCostUsd.
export async function findBuyers(userId: string, rec: HiringRecord, opts: FindBuyersOpts): Promise<FindBuyersOutcome> {
  const sheet = rec.companies_sheet_id;
  const view = buyerOf(userId, rec);
  const titles = opts.titles ?? (view.added ? view.titles : view.starting);
  if (titles.length === 0) {
    return bad('Who buys? Give the job titles of the people to find at each company, such as Head of Sales.');
  }
  const email = newestColumnRun(sheet, userId, BUYER_COLUMNS.emailSearch);
  const emailThere = !!email && getSheetColumns(sheet, userId, false).includes(BUYER_COLUMNS.emailSearch);
  const saveSearch = !view.added || !same(titles, view.titles);
  if ((saveSearch || !emailThere) && opts.canSave === false) {
    return { fail: 'forbidden', message: 'Saving the buyer columns needs the write scope: ask for a token with it, or '
      + 'add them in the app (Find buyers on the hiring table).' };
  }
  // Both checked before either is saved, so a refusal leaves Companies as it was.
  const clash = inTheWay(userId, sheet, [
    ...(view.added ? [] : [BUYER_COLUMNS.search, BUYER_COLUMNS.name, BUYER_COLUMNS.title, BUYER_COLUMNS.linkedin]),
    ...(emailThere ? [] : [BUYER_COLUMNS.emailSearch, BUYER_COLUMNS.email, BUYER_COLUMNS.emailStatus]),
  ]);
  if (clash) return bad(clash);
  const before = new Set(getSheetColumns(sheet, userId, false));
  const saved: string[] = [];
  if (saveSearch) {
    // One person a call: its most is the tool's price for one (the catalog read here, as the start reads it).
    const tool = await getTool(BUYER_TOOL_ID);
    const one = 'ok' in tool && tool.ok.price.type === 'per_result' ? tool.ok.price.usd : null;
    const out = await startEnrichmentRun(userId, sheet, buyerSearchInput(titles, view.added, one));
    if ('fail' in out) return out;
    saved.push(BUYER_COLUMNS.search);
  }
  if (!emailThere) {
    const out = await startEnrichmentRun(userId, sheet, buyerEmailInput());
    if ('fail' in out) return out;
    saved.push(BUYER_COLUMNS.emailSearch);
  }
  const added = getSheetColumns(sheet, userId, false).filter(c => !before.has(c));
  const run = await runColumns(userId, sheet, {
    columns: [BUYER_COLUMNS.search, BUYER_COLUMNS.emailSearch], mode: opts.rows, rowIds: null, where: null,
    estimateOnly: opts.estimateOnly, maxCostUsd: opts.maxCostUsd, allowUnpriced: false, webhookId: null,
  }, { hasSecretsScope: false });
  if ('fail' in run) return run;
  return { ok: { ...run.ok, saved, added, titles } };
}
