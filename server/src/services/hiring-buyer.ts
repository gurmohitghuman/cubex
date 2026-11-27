// "Find buyers" on a hiring table (plans/find-jobs-buyer.md): the person each company in Companies would buy through,
// found by job title, with a verified work email (the columns' setups: lib/hiring/buyer.ts). It takes the companies
// whose Buyer is empty (services/hiring-buyer-price.ts). The estimate is a pure read: before the columns exist it
// prices their setups as they would be saved. The run saves them first, as the enrichment drawer's Save does
// (startEnrichmentRun with saveOnly: every check a start makes, the treg key included), and new titles save the people
// search's setup again, its cells kept; then both run as one column run (services/column-run.ts), the email after the
// search it reads, under a ceiling (max_cost_usd) the whole run stays within. One implementation for the app,
// /api/v1 and MCP.
import { getSheetColumns } from '../lib/sql-helpers';
import { inputTemplates } from '../lib/enrich-run-config';
import { BUYER_COLUMNS } from '../lib/hiring/names';
import {
  BUYER_TOOL_ID, buyerEmailInput, buyerOutputNames, buyerSearchInput, buyerTitlesFor, titlesOfInput,
  type BuyerOutputNames,
} from '../lib/hiring/buyer';
import { newestColumnRun } from './enrich-column';
import { getTool } from './enrich-catalog';
import { startEnrichmentRun } from './enrich-run-start';
import { runColumns, type ColumnRunOutcome } from './column-run';
import { buyerPick, priceUnsaved } from './hiring-buyer-price';
import type { HiringRecord } from './hiring-store';
import type { RunFail } from './run-shared';

// added: the people search's column is on Companies; titles: the titles it searches (none until added);
// starting: the titles "Find buyers" starts with for this table's roles (lib/hiring/buyer.ts); catchAll: the email
// column keeps catch-all addresses too (its check's balanced; off until chosen).
export interface BuyerView { added: boolean; titles: string[]; starting: string[]; catchAll: boolean }

const rolesOf = (rec: HiringRecord): string[] => {
  try {
    const v = JSON.parse(rec.roles);
    return Array.isArray(v) ? v.filter((r): r is string => typeof r === 'string') : [];
  } catch { return []; }
};

// A buyer column's newest setup, while its column is on Companies.
function savedRun(userId: string, sheet: string, column: string) {
  const run = newestColumnRun(sheet, userId, column);
  return run && getSheetColumns(sheet, userId, false).includes(column) ? run : null;
}

export function buyerOf(userId: string, rec: HiringRecord): BuyerView {
  const run = savedRun(userId, rec.companies_sheet_id, BUYER_COLUMNS.search);
  const email = savedRun(userId, rec.companies_sheet_id, BUYER_COLUMNS.emailSearch);
  return {
    added: !!run, titles: run ? titlesOfInput(inputTemplates(run.config)) ?? [] : [],
    starting: buyerTitlesFor(rolesOf(rec)), catchAll: email?.config.enrichment.email?.strategy === 'balanced',
  };
}

// canSave: the caller may save column setups (an access token with the write scope); without it, a run that would
// save one is refused before anything changes. catchAll: keep catch-all emails too; null or left out: as saved (off
// the first time). A new choice saves the email column's setup again, as new titles save the search's.
export interface FindBuyersOpts {
  titles: string[] | null; estimateOnly: boolean; maxCostUsd: number | null; canSave?: boolean;
  catchAll?: boolean | null;
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

// One person a call: its most a company is the tool's price for one, the higher of its two (as Cubex's own default
// takes them), read from the catalog as the start reads it.
async function onePersonUsd(): Promise<number | null> {
  const tool = await getTool(BUYER_TOOL_ID);
  if (!('ok' in tool) || tool.ok.price.type !== 'per_result') return null;
  const { usd, overflowUsd } = tool.ok.price;
  return usd === null && overflowUsd === null ? null : Math.max(usd ?? 0, overflowUsd ?? 0);
}

export async function findBuyers(userId: string, rec: HiringRecord, opts: FindBuyersOpts): Promise<FindBuyersOutcome> {
  const sheet = rec.companies_sheet_id;
  const view = buyerOf(userId, rec);
  const titles = opts.titles ?? (view.added ? view.titles : view.starting);
  if (titles.length === 0) {
    return bad('Who buys? Give the job titles of the people to find at each company, such as Head of Sales.');
  }
  const search = savedRun(userId, sheet, BUYER_COLUMNS.search);
  const emailThere = !!savedRun(userId, sheet, BUYER_COLUMNS.emailSearch);
  const names: BuyerOutputNames = buyerOutputNames(search?.config ?? null);
  // Every column it would add, checked before anything is saved.
  const clash = inTheWay(userId, sheet, [
    ...(search ? [] : [BUYER_COLUMNS.search, names.name, names.jobTitle, names.linkedinUrl]),
    ...(emailThere ? [] : [BUYER_COLUMNS.emailSearch, BUYER_COLUMNS.email, BUYER_COLUMNS.emailStatus]),
  ]);
  if (clash) return bad(clash);
  const saveSearch = !search || !same(titles, view.titles);
  const catchAll = opts.catchAll ?? view.catchAll;
  const saveEmail = !emailThere || catchAll !== view.catchAll;
  const one = saveSearch || !emailThere ? await onePersonUsd() : null;
  const columns = [BUYER_COLUMNS.search, BUYER_COLUMNS.emailSearch];

  if (opts.estimateOnly) {
    const pick = await buyerPick(userId, sheet, names.name);
    if ('fail' in pick) return pick;
    if (!search || !emailThere) {
      const est = await priceUnsaved(userId, [buyerSearchInput(titles, !!search, one, names),
        buyerEmailInput(names, { catchAll })], pick.ok.rows);
      return 'fail' in est ? est : { ok: { estimate: est.ok, saved: [], added: [], titles } };
    }
    const run = await runColumns(userId, sheet, {
      columns, mode: pick.ok.mode, rowIds: pick.ok.rowIds, where: null, estimateOnly: true, maxCostUsd: null,
      allowUnpriced: false, webhookId: null,
    }, { hasSecretsScope: false });
    return 'fail' in run ? run : { ok: { ...run.ok, saved: [], added: [], titles } };
  }

  if ((saveSearch || saveEmail) && opts.canSave === false) {
    return { fail: 'forbidden', message: 'Finding buyers the first time, with new titles or a new catch-all choice, '
      + 'saves the buyer columns: '
      + 'that needs the write scope. Ask for a token with it, or find them in the app (Find buyers on the hiring '
      + 'table).' };
  }
  const before = new Set(getSheetColumns(sheet, userId, false));
  const saved: string[] = [];
  if (saveSearch) {
    const out = await startEnrichmentRun(userId, sheet, buyerSearchInput(titles, !!search, one, names));
    if ('fail' in out) return out;
    saved.push(BUYER_COLUMNS.search);
  }
  if (saveEmail) {
    const out = await startEnrichmentRun(userId, sheet, buyerEmailInput(names, { catchAll, again: emailThere }));
    if ('fail' in out) return out;
    saved.push(BUYER_COLUMNS.emailSearch);
  }
  const added = getSheetColumns(sheet, userId, false).filter(c => !before.has(c));
  // Picked once Buyer is there, so the first run takes the same companies its estimate priced.
  const pick = await buyerPick(userId, sheet, names.name);
  if ('fail' in pick) return pick;
  const run = await runColumns(userId, sheet, {
    columns, mode: pick.ok.mode, rowIds: pick.ok.rowIds, where: null, estimateOnly: false,
    maxCostUsd: opts.maxCostUsd, allowUnpriced: false, webhookId: null,
  }, { hasSecretsScope: false });
  if ('fail' in run) return run;
  return { ok: { ...run.ok, saved, added, titles } };
}
