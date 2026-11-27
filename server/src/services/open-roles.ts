// Open roles at the companies on a person's own sheet: one implementation for the app, /api/v1 and MCP
// (plans/find-jobs-open-roles.md). For each company row with a website, hirebase's job index is asked for the roles
// asked (lib/hiring/open-roles-input.ts); each role found becomes a row in an Open roles sheet beside it, and two
// lookups on the company sheet count and list each company's roles.
// The estimate first (a pure read, and free): the companies, the most the run can cost (every row at its most), and
// the free count of roles they match, over the first companies with a website. Then, only when asked, the run: the
// Open roles sheet made the first time, the search column's run on every row (kept: only roles the Open roles sheet
// never had are added, First seen the run's day), and the two lookups made the first time. The start carries the
// most the asker was shown: worked out again, a higher most is refused with the new estimate, so a run never spends
// more than its estimate showed; the run's spend limit is that most. The lookups come after the start (a lookup's
// fill holds the sheet, which a start would wait for); a sheet busy then gets them at the next start.
import { db } from '../lib/db';
import { countRows, getSheetColumns, parseRowData, verifySheetOwnership } from '../lib/sql-helpers';
import { appendColumnsToOrder } from '../lib/sheet-columns';
import { getColumnTypes } from '../lib/column-types';
import { createSheetTxn } from '../lib/sheet-crud-helpers';
import { writeColumnDescription } from '../lib/column-descriptions';
import { logSheetChange } from '../lib/change-log';
import { dayIn } from '../lib/ai-visibility/check';
import { nowDate } from '../lib/clock';
import { micro, moneyUp } from '../lib/cost-ceiling';
import { buildRequest } from '../lib/enrich-request';
import { inputTemplates } from '../lib/enrich-run-config';
import { cellOf } from '../lib/row-cell';
import { HIRING_COUNT_MAX_SEARCHES, OPEN_ROLES_LOOKUPS_LATER_MS, OPEN_ROLES_LOOKUPS_WAIT_MS } from '../lib/constants';
import { sheetFreeWithin } from '../lib/sheet-busy';
import { HIRING_DIRECT_TOOL_ID, OPEN_ROLES, OPEN_ROLES_WORDS, ROLE_COLUMNS } from '../lib/hiring/names';
import { OPEN_ROLE_COLUMNS, openRolesInput, openRolesOf, type OpenRolesOptions } from '../lib/hiring/open-roles-input';
import { newestColumnRun } from './enrich-column';
import { buildEnrichmentConfig } from './enrich-run-build';
import { estimateEnrichment, type EnrichEstimateView } from './enrich-setup';
import { startEnrichmentRun } from './enrich-run-start';
import { countDirectJobs, type JobCount } from './job-count';
import { startLookupColumn } from './lookup-column';
import type { RunFail } from './run-shared';

export interface OpenRolesEstimate {
  // Rows the run asks about (every row; one with no website isn't searched, nor paid for).
  companies: number;
  rolesUpTo: number; priceKnown: boolean; lowUsd: number; highUsd: number;
  dailyLimit: EnrichEstimateView['dailyLimit'];
  // The free count, "about", over the first companies with a website (null: the index didn't answer).
  matches: JobCount | null;
}
export interface OpenRolesStarted {
  runId: string; column: string; rolesSheetId: string; rolesSheetName: string;
  // The lookups on the company sheet; left: why one isn't there yet (made at the next start).
  lookups: string[]; lookupsLeft: string | null;
}
export interface OpenRolesRequest extends OpenRolesOptions {
  estimateOnly: boolean; maxCostUsd: number | null; timeZone: string | null;
  // An agent's run (its spend cap and run-start window), asked just before the start.
  refuse?: () => string | null;
}
export type OpenRolesFail = RunFail & { estimate?: OpenRolesEstimate };
export type OpenRolesAnswer = { ok: { estimate: OpenRolesEstimate } } | { ok: { started: OpenRolesStarted } }
  | OpenRolesFail;

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const today = (timeZone: string | null) => dayIn(nowDate().toISOString().replace('T', ' ').slice(0, 19), timeZone);

// What a sheet has of an earlier run: its search column and the live Open roles sheet that column adds to.
interface Setup { column: string; rolesSheetId: string; rolesSheetName: string; active: boolean; paused: boolean }

function liveSheet(userId: string, sheetId: string): { name: string; table_id: string } | null {
  return (db.prepare('SELECT name, table_id FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL')
    .get(sheetId, userId) as { name: string; table_id: string } | undefined) ?? null;
}

// The search column: named as OPEN_ROLES.status (or with a number after it), filled by the job index, adding rows
// to a live sheet.
function setupOf(userId: string, sheetId: string): Setup | null {
  const types = getColumnTypes(sheetId, userId);
  for (const c of getSheetColumns(sheetId, userId)) {
    if (types[c] !== 'enrich-status' || !(c === OPEN_ROLES.status || c.startsWith(`${OPEN_ROLES.status} `))) continue;
    const run = newestColumnRun(sheetId, userId, c);
    const e = run?.config.enrichment;
    const dest = e?.toolId === HIRING_DIRECT_TOOL_ID ? e.list?.destSheetId : undefined;
    const sheet = dest ? liveSheet(userId, dest) : null;
    if (run && dest && sheet) {
      return { column: c, rolesSheetId: dest, rolesSheetName: sheet.name, active: run.active,
        paused: run.status === 'paused' };
    }
  }
  return null;
}

// A name not taken in `taken`: base, else "base 2", "base 3"...
function freeName(base: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map(t => t.toLowerCase()));
  let name = base;
  for (let n = 2; lower.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}

// Why this sheet can't be searched, or null.
function refusal(userId: string, sheetId: string, o: OpenRolesOptions): RunFail | null {
  if (!verifySheetOwnership(sheetId, userId) || !liveSheet(userId, sheetId)) {
    return { fail: 'not_found', message: 'Sheet not found' };
  }
  const hiring = db.prepare(`SELECT 1 FROM hiring_signals WHERE user_id = ? AND (companies_sheet_id = ?
      OR roles_sheet_id = ? OR searches_sheet_id = ?) LIMIT 1`).get(userId, sheetId, sheetId, sheetId);
  if (hiring) {
    return bad('This sheet is part of a hiring table, which finds its roles itself: use Check again on it.');
  }
  if (!getSheetColumns(sheetId, userId).includes(o.websiteColumn)) {
    return bad(`This sheet has no column "${o.websiteColumn}". Pick the column holding each company's website.`);
  }
  return null;
}

// The first rows with a website, for the free count (HIRING_COUNT_MAX_SEARCHES of them at most, in row order; a
// few pages read, never the whole sheet).
const PAGE_ROWS = 200;
const MAX_PAGES = 10;
function firstWebsites(userId: string, sheetId: string, column: string): Array<Record<string, string>> {
  const read = db.prepare(`SELECT row_index, data FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ?
    ORDER BY row_index LIMIT ?`);
  const rows: Array<Record<string, string>> = [];
  let after = -1;
  // Pages of PAGE_ROWS: a sheet whose first rows have no website is read on, MAX_PAGES pages at most.
  for (let page = 0; page < MAX_PAGES && rows.length < HIRING_COUNT_MAX_SEARCHES; page++) {
    const got = read.all(sheetId, userId, after, PAGE_ROWS) as Array<{ row_index: number; data: string }>;
    for (const r of got) {
      const data = parseRowData(r.data) as Record<string, string>;
      if (String(cellOf(data, column) ?? '').trim() && rows.length < HIRING_COUNT_MAX_SEARCHES) rows.push(data);
    }
    if (got.length < PAGE_ROWS) break;
    after = got[got.length - 1].row_index;
  }
  return rows;
}

async function estimateOf(userId: string, sheetId: string, o: OpenRolesOptions, setup: Setup | null):
  Promise<OpenRolesEstimate | RunFail> {
  const companies = countRows(sheetId, userId);
  if (companies === 0) return bad('This sheet has no rows: add the companies to look at first.');
  const columns = getSheetColumns(sheetId, userId);
  const input = openRolesInput(o, setup?.rolesSheetId ?? '', today(null), !!setup);
  const [est, config] = await Promise.all([
    estimateEnrichment(userId, {
      toolId: HIRING_DIRECT_TOOL_ID, rows: companies, preset: null, maxCostPerRowUsd: null, limit: null,
      list: { provider: null, maxItems: o.perCompany, destSheetId: setup?.rolesSheetId ?? null },
      skip: [], given: Object.keys(input.inputs), order: [], stopAtFirst: false,
    }),
    buildEnrichmentConfig(input, columns, companies),
  ]);
  if (!('ok' in est)) return { fail: 'upstream', message: `treg's job index can't be read now: ${est.message}` };
  if ('fail' in config) return { fail: config.fail, message: `The search: ${config.message}` };
  const templates = inputTemplates(config.ok);
  const bodies = firstWebsites(userId, sheetId, o.websiteColumn).flatMap(row => {
    const built = buildRequest(config.ok.enrichment.toolSnapshot, templates, row, { cleanDomains: true, columns });
    if (!built.ok || !built.body) return [];
    const body: unknown = JSON.parse(built.body);
    return body && typeof body === 'object' && !Array.isArray(body) ? [body as Record<string, unknown>] : [];
  });
  const matches = bodies.length ? await countDirectJobs(userId, bodies) : null;
  const e = est.ok;
  return {
    companies, rolesUpTo: e.list?.addUpTo ?? companies * o.perCompany, priceKnown: e.priceKnown,
    lowUsd: e.estimate.lowUsd, highUsd: e.estimate.highUsd, dailyLimit: e.dailyLimit, matches,
  };
}

// The Open roles sheet, beside the company sheet in its table (a free name). One transaction.
function makeRolesSheet(userId: string, sheetId: string, o: OpenRolesOptions): { id: string; name: string } {
  return db.transaction(() => {
    const table = liveSheet(userId, sheetId)!.table_id;
    const names = (db.prepare('SELECT name FROM sheets WHERE table_id = ? AND user_id = ? AND trash_id IS NULL')
      .all(table, userId) as Array<{ name: string }>).map(s => s.name);
    const name = freeName(OPEN_ROLES.sheet, names);
    const made = createSheetTxn(table, userId, name, sheetId, { seed: false });
    if (!made.ok) throw new Error(`The ${name} sheet could not be made.`);
    appendColumnsToOrder(made.sheetId, userId, OPEN_ROLE_COLUMNS);
    db.prepare('UPDATE sheets SET description = ? WHERE id = ? AND user_id = ?')
      .run(OPEN_ROLES_WORDS.sheet, made.sheetId, userId);
    writeColumnDescription(made.sheetId, userId, ROLE_COLUMNS.firstSeen, 'The day of the run that found this role.');
    writeColumnDescription(made.sheetId, userId, ROLE_COLUMNS.domain, 'The company\'s website, as its sheet has it.');
    logSheetChange(sheetId, userId, 'hiring_created', `Made the ${name} sheet for ${o.roles.join(', ')}`,
      { detail: { roles: o.roles, websiteColumn: o.websiteColumn, country: o.country, place: o.place } });
    return { id: made.sheetId, name };
  }).immediate();
}

// The two lookups on the company sheet, each made once (found again by what it looks up, whatever its name). Each
// waits for the sheet first, at most waitMs (the run's start, then the first lookup's fill, hold it).
async function ensureLookups(userId: string, sheetId: string, o: OpenRolesOptions, rolesSheetId: string,
  waitMs: number): Promise<{ lookups: string[]; left: string | null }> {
  const have = db.prepare(`SELECT column_name, returns FROM lookup_columns WHERE sheet_id = ? AND user_id = ?
    AND other_sheet_id = ? AND match_column = ?`).all(sheetId, userId, rolesSheetId, ROLE_COLUMNS.domain) as
    Array<{ column_name: string; returns: string }>;
  const columns = getSheetColumns(sheetId, userId);
  const live = (returns: string) => have.find(h => h.returns === returns && columns.includes(h.column_name));
  const lookups: string[] = [];
  const wanted = [
    { returns: 'count', base: OPEN_ROLES.count, words: OPEN_ROLES_WORDS.count, extra: {} },
    { returns: 'list', base: OPEN_ROLES.titles, words: OPEN_ROLES_WORDS.titles,
      extra: { returnColumns: [ROLE_COLUMNS.title], limit: 5 } },
  ];
  for (const w of wanted) {
    const found = live(w.returns);
    if (found) { lookups.push(found.column_name); continue; }
    const held = await sheetFreeWithin(sheetId, waitMs);
    if (held) return { lookups, left: `The "${w.base}" column is added once the sheet is free (${held}).` };
    const column = freeName(w.base, getSheetColumns(sheetId, userId));
    const made = await startLookupColumn(userId, sheetId, {
      column, sourceColumn: o.websiteColumn, otherSheetId: rolesSheetId, matchColumn: ROLE_COLUMNS.domain,
      match: 'equals', returns: w.returns, ...w.extra,
    });
    if ('fail' in made) {
      return { lookups, left: `The "${w.base}" column isn't there yet (${made.message}). It is made at the next run.` };
    }
    writeColumnDescription(sheetId, userId, made.ok.column, w.words);
    lookups.push(made.ok.column);
  }
  return { lookups, left: null };
}

// The lookups once the run's start has set up the sheet's rows (it holds the sheet meanwhile): now when that is quick,
// else in the background as soon as the sheet is free (or at the next run).
async function lookupsAfterStart(userId: string, sheetId: string, o: OpenRolesOptions, rolesSheetId: string):
  Promise<{ lookups: string[]; left: string | null }> {
  const now = await ensureLookups(userId, sheetId, o, rolesSheetId, OPEN_ROLES_LOOKUPS_WAIT_MS);
  if (!now.left) return now;
  void ensureLookups(userId, sheetId, o, rolesSheetId, OPEN_ROLES_LOOKUPS_LATER_MS).then(later => {
    if (later.left) console.error(`Open roles: ${later.left} The next run adds it.`);
  }, (error: Error) => {
    console.error(`Open roles: the lookups weren't added (${error.message}); the next run adds them.`);
  });
  return now;
}

// What the sheet's search column was last run with (options null: not readable), for the app to show it again;
// null when it was never run here.
export interface OpenRolesSetupView {
  options: OpenRolesOptions | null; column: string; rolesSheetId: string; rolesSheetName: string; going: boolean;
}
export function openRolesSetup(userId: string, sheetId: string): OpenRolesSetupView | null {
  if (!verifySheetOwnership(sheetId, userId)) return null;
  const setup = setupOf(userId, sheetId);
  if (!setup) return null;
  const config = newestColumnRun(sheetId, userId, setup.column)!.config;
  return {
    options: openRolesOf(inputTemplates(config), config.enrichment.list?.maxItems ?? 0), column: setup.column,
    rolesSheetId: setup.rolesSheetId, rolesSheetName: setup.rolesSheetName, going: setup.active,
  };
}

export async function openRoles(userId: string, sheetId: string, req: OpenRolesRequest): Promise<OpenRolesAnswer> {
  const refused = refusal(userId, sheetId, req);
  if (refused) return refused;
  const setup = setupOf(userId, sheetId);
  if (setup?.active) {
    return { fail: 'conflict', message: setup.paused
      ? `The last run is paused: resume or cancel "${setup.column}", then run it again.`
      : `"${setup.column}" is still searching: run it again once it's done.` };
  }
  const est = await estimateOf(userId, sheetId, req, setup);
  if ('fail' in est) return est;
  if (req.estimateOnly) return { ok: { estimate: est } };
  // With no price, the run would have no most to stop at.
  if (!est.priceKnown) {
    return bad("treg doesn't say what the job index costs now, so a run can't keep to a most. Try again later.");
  }
  // In micro-dollars, as run ceilings are (lib/cost-ceiling.ts). A most that isn't a number counts as none.
  const sent = req.maxCostUsd !== null && Number.isFinite(req.maxCostUsd) ? req.maxCostUsd : 0;
  if (micro(est.highUsd) > micro(sent)) {
    return { fail: 'over_ceiling', estimate: est, message: `This could now cost up to ${moneyUp(est.highUsd)}, more `
      + `than the ${moneyUp(sent)} it was sent (rows or prices changed since the estimate). Nothing was searched: `
      + 'confirm the new most to run it.' };
  }
  const refusedNow = req.refuse?.() ?? null;
  if (refusedNow) return { fail: 'forbidden', message: refusedNow };
  // The search column: ours from before, else a free name (a column of that name may be the person's own).
  const column = setup?.column ?? freeName(OPEN_ROLES.status, getSheetColumns(sheetId, userId));
  const roles = setup ? { id: setup.rolesSheetId, name: setup.rolesSheetName } : makeRolesSheet(userId, sheetId, req);
  const input = { ...openRolesInput(req, roles.id, today(req.timeZone), !!setup), columnName: column,
    spendLimitUsd: est.highUsd, noReuse: true };
  const started = await startEnrichmentRun(userId, sheetId, input)
    .catch((error: Error): RunFail => ({ fail: 'upstream', message: error.message }));
  if ('fail' in started) return started;
  writeColumnDescription(sheetId, userId, column, OPEN_ROLES_WORDS.status);
  const lookups = await lookupsAfterStart(userId, sheetId, req, roles.id);
  return { ok: { started: { runId: started.ok.runId, column, rolesSheetId: roles.id, rolesSheetName: roles.name,
    lookups: lookups.lookups, lookupsLeft: lookups.left } } };
}
