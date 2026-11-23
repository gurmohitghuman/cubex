// A hiring table: one implementation for the app, /api/v1 and MCP. A new
// table "Hiring: <roles>" with a Companies sheet (one row per company, filled
// by each check), a Roles sheet (every role found) and a Searches sheet (one
// row per role title, a column per More filter when it has any, and "Roles
// found": a list enrichment set up and not run that adds the roles each search
// finds to Roles, keeping those added before: lib/hiring/search-input.ts).
// Its filters on Companies go on the record (lib/hiring/company-filters.ts).
// Nothing that costs money runs: a check takes the person's click or an
// agent's call (services/hiring-check.ts). The search's config is checked
// against treg's catalog first, then the table, sheets, rows, column and
// record go in one transaction. It is an ordinary table: deleting it puts it in the trash.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { appendColumnsToOrder, getSheetColumns } from '../lib/sql-helpers';
import { createSheetTxn } from '../lib/sheet-crud-helpers';
import { writeColumnDescription } from '../lib/column-descriptions';
import { logSheetChange, withoutChangeLog } from '../lib/change-log';
import { MAX_COLUMNS_PER_SHEET, MAX_TABLE_NAME_LENGTH } from '../lib/constants';
import type { EnrichRunConfig } from '../lib/enrich-run-config';
import type { EnrichRunInput } from '../lib/enrich-run-input';
import type { HiringInput } from '../lib/hiring/input';
import { countryName, FILTER_KEYS } from '../lib/hiring/filters';
import { ROUTED_INPUTS, searchColumns, searchInput } from '../lib/hiring/search-input';
import {
  COLUMN_WORDS, COMPANY_COLUMNS, FILTER_COLUMN_WORDS, FILTER_COLUMNS, HIRING_DIRECT_PROVIDER, HIRING_DIRECT_TOOL_ID,
  HIRING_SHEETS, HIRING_TOOL_ID, ROLE_COLUMNS, SEARCH_COLUMNS, SHEET_WORDS, hiringTableBase,
} from '../lib/hiring/names';
import { createTable } from './table-crud';
import { appendRows } from './rows-write';
import { getTool } from './enrich-catalog';
import { buildEnrichmentConfig } from './enrich-run-build';
import { listProviders } from './enrich-list-build';
import { applyListStart, planListStart } from './enrich-list-start';
import { writeHttpSetup } from './setup-version-write';
import { startRunRule } from './run-rule';
import type { RunFail } from './run-shared';

export interface HiringTable {
  id: string; tableId: string; tableName: string; companiesSheetId: string; rolesSheetId: string;
  searchesSheetId: string; searches: number; provider: string | null; perSearch: number;
}

// Without filters, the first provider treg's plan lists that can search by
// title, in a sheet; with them, the job index that takes them.
async function searchConfig(input: HiringInput): Promise<{ ok: { input: EnrichRunInput;
  config: EnrichRunConfig } } | RunFail> {
  const direct = input.filters !== null;
  const tool = await getTool(direct ? HIRING_DIRECT_TOOL_ID : HIRING_TOOL_ID);
  if (!('ok' in tool)) return { fail: 'upstream', message: `treg's job search can't be read now: ${tool.message}` };
  const provider = direct ? null : listProviders(tool.ok, Object.keys(ROUTED_INPUTS))[0]?.provider ?? null;
  if (!direct && !provider) {
    return { fail: 'bad_request', message: 'No job search provider can search by role title now.' };
  }
  const search = searchInput(direct, provider, input.perSearch, '');
  const config = await buildEnrichmentConfig(search, searchColumns(direct), input.roles.length);
  if ('fail' in config) return { fail: config.fail, message: `The job search: ${config.message}` };
  return { ok: { input: search, config: config.ok } };
}

function freeTableName(userId: string, roles: string[]): string {
  const base = hiringTableBase(roles, MAX_TABLE_NAME_LENGTH - 4);
  const taken = db.prepare('SELECT 1 FROM tables WHERE user_id = ? AND name = ? AND trash_id IS NULL LIMIT 1');
  let name = base;
  for (let n = 2; taken.get(userId, name); n++) name = `${base} ${n}`;
  return name;
}

function describe(sheetId: string, userId: string, sheet: keyof typeof COLUMN_WORDS, filters = false): void {
  db.prepare('UPDATE sheets SET description = ? WHERE id = ? AND user_id = ?').run(SHEET_WORDS[sheet], sheetId, userId);
  const words = { ...COLUMN_WORDS[sheet], ...(filters ? FILTER_COLUMN_WORDS : {}) };
  for (const [column, text] of Object.entries(words)) writeColumnDescription(sheetId, userId, column, text);
}

// A search row's cells. With filters, the country by name (the job index takes it so) and a comma list per filter.
function searchRow(input: HiringInput, role: string): Record<string, string> {
  const f = input.filters;
  const country = input.country ? (f ? countryName(input.country) : input.country) : '';
  return {
    [SEARCH_COLUMNS.role]: role, [SEARCH_COLUMNS.country]: country, [SEARCH_COLUMNS.place]: input.place ?? '',
    [SEARCH_COLUMNS.days]: input.postedWithinDays === null ? '' : String(input.postedWithinDays),
    ...(f ? Object.fromEntries(FILTER_KEYS.map(k => [FILTER_COLUMNS[k], f[k].join(', ')])) : {}),
  };
}

function newSheet(tableId: string, userId: string, name: string, after: string, columns: string[]): string {
  const made = createSheetTxn(tableId, userId, name, after, { seed: false });
  if (!made.ok) throw new Error(`The ${name} sheet could not be made.`);
  appendColumnsToOrder(made.sheetId, userId, columns);
  return made.sheetId;
}

// Inside the create transaction: the search column, set up and not run. Throws (rolling it all back).
function writeSearch(userId: string, searches: string, roles: string, built: { input: EnrichRunInput;
  config: EnrichRunConfig }): void {
  const input: EnrichRunInput = { ...built.input, list: { ...built.input.list!, dest: { sheetId: roles } } };
  const plan = planListStart(userId, searches, input, built.config, getSheetColumns(searches, userId));
  if ('fail' in plan || !plan.ok) throw new Error(`The search: ${'fail' in plan ? plan.message : 'no list'}`);
  const dest = applyListStart(userId, searches, SEARCH_COLUMNS.status, plan.ok, built.config);
  if ('raced' in dest) throw new Error(`The search: ${dest.raced}`);
  appendColumnsToOrder(searches, userId, [SEARCH_COLUMNS.status]);
  // Its "Only run if" (a row with a role title), checked against the sheet as a start checks it.
  const rule = startRunRule(searches, userId, input.runIf);
  if ('fail' in rule) throw new Error(`The search: ${rule.message}`);
  const config: EnrichRunConfig = rule.ok ? { ...built.config, runIf: rule.ok.rule } : built.config;
  writeHttpSetup(searches, userId, SEARCH_COLUMNS.status, {
    kind: 'http', mode: 'enrichment', config, allowSecrets: 0, destSheetId: dest.destSheetId, extracted: [],
  }, getSheetColumns(searches, userId), false, 2);
}

type Made = Omit<HiringTable, 'searches' | 'provider' | 'perSearch'>;
function makeTable(userId: string, input: HiringInput, built: { input: EnrichRunInput;
  config: EnrichRunConfig }): Made | RunFail {
  return db.transaction((): Made | RunFail => {
    const made = withoutChangeLog(() => createTable(userId, freeTableName(userId, input.roles)));
    if ('fail' in made) return { fail: 'bad_request', message: made.message };
    const { id: tableId, name: tableName, sheetId: companies } = made.ok;
    logSheetChange(companies, userId, 'hiring_created',
      `Made the hiring table for ${input.roles.join(', ')}: ${input.roles.length} searches`,
      { detail: { roles: input.roles, country: input.country, place: input.place, filters: input.filters,
        companyFilters: input.companyFilters } });
    db.prepare('UPDATE sheets SET name = ? WHERE id = ? AND user_id = ?')
      .run(HIRING_SHEETS.companies, companies, userId);
    appendColumnsToOrder(companies, userId, Object.values(COMPANY_COLUMNS));
    describe(companies, userId, 'companies');
    const roles = newSheet(tableId, userId, HIRING_SHEETS.roles, companies, Object.values(ROLE_COLUMNS));
    describe(roles, userId, 'roles');
    const searches = newSheet(tableId, userId, HIRING_SHEETS.searches, roles, searchColumns(!!input.filters));
    describe(searches, userId, 'searches', !!input.filters);
    const rows = appendRows(searches, userId, input.roles.map(r => searchRow(input, r)));
    if ('fail' in rows) throw new Error(`The searches didn't go in: ${rows.fail}`);
    writeSearch(userId, searches, roles, built);
    const id = uuidv4();
    const { minRoles, leaveOutCompanies } = input.companyFilters;
    db.prepare(`INSERT INTO hiring_signals (id, user_id, table_id, companies_sheet_id, roles_sheet_id,
        searches_sheet_id, roles, country, place, posted_within_days, min_roles, leave_out_companies)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, tableId, companies, roles, searches, JSON.stringify(input.roles), input.country, input.place,
        input.postedWithinDays, minRoles, JSON.stringify(leaveOutCompanies));
    return { id, tableId, tableName, companiesSheetId: companies, rolesSheetId: roles, searchesSheetId: searches };
  }).immediate();
}

export async function createHiringTable(userId: string, input: HiringInput): Promise<{ ok: HiringTable } | RunFail> {
  if (MAX_COLUMNS_PER_SHEET < Object.keys(COMPANY_COLUMNS).length) {
    return { fail: 'bad_request', message: `This Cubex allows ${MAX_COLUMNS_PER_SHEET} columns per sheet, too few.` };
  }
  const built = await searchConfig(input);
  if ('fail' in built) return built;
  const made = makeTable(userId, input, built.ok);
  if ('fail' in made) return made;
  return {
    ok: { ...made, searches: input.roles.length, perSearch: input.perSearch,
      provider: input.filters ? HIRING_DIRECT_PROVIDER : built.ok.input.list!.provider },
  };
}
