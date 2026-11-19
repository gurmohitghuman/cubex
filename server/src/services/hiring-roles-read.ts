// A check's summary reads (services/hiring-summarize.ts): the Roles sheet a
// page at a time, in its order, other requests served between pages, each
// role folded into its company (lib/hiring/summary.ts). A role counts as new
// when this check's run added it. Memory grows with the companies kept, a few
// hundred bytes each, never with a company's roles: a read keeps at most `cap`
// companies. Past that, a whole read drops them and only counts the companies
// from a sample of their keys (overflow: about how many there are); a batch's
// read keeps only that batch's companies (lib/hiring/company-key.ts keyBatch)
// and stops past `cap` (overflow). A read stops when Roles goes to the trash.
import { db } from '../lib/db';
import { getSheetColumns, jsonPath, verifySheetOwnership } from '../lib/sql-helpers';
import { yieldToRequests } from '../lib/slices';
import { HIRING_SUMMARY_COUNT_SAMPLE, HIRING_SUMMARY_READ_ROWS, HIRING_SUMMARY_SLICE_MS } from '../lib/constants';
import { companyKey, keyBatch, plainCompanyName } from '../lib/hiring/company-key';
import { ROLE_COLUMNS } from '../lib/hiring/names';
import { addRole, mergeAcc, newAcc, type CompanyAcc } from '../lib/hiring/summary';

export interface RolesRead {
  companies: Map<string, CompanyAcc>;   // by company key, in the order first seen
  roles: number; newRoles: number;
  byName: number;                       // roles with no domain, summed up by company name
  noCompany: number;                    // roles with neither: left out
  newNoKey: number;                     // new roles with nothing to tell them apart: a later check can add them again
  missing: string[];                    // Roles columns the summary reads that aren't there
}
// One batch of the companies (index of `of`), and the domain key each company
// name seen with no domain joins (nameRemap, below).
export interface RolesBatch { index: number; of: number; remap: Map<string, string> }
// overflow: past `cap`; a whole read says about how many companies there are.
export type RolesOutcome = RolesRead | { overflow: number } | { gone: true };
export interface RoleCells {
  title: string; company: string; domain: string; posted: string; link: string;
  added: number;                        // 0: not this check's; 1: its run added it; 2: the same, with no key
}

const READ = ['title', 'company', 'domain', 'posted', 'link'] as const;
const text = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());

// Every role of Roles in its order; `each` answering false stops the walk. Read only.
export async function eachRole(
  userId: string, rolesSheetId: string, runId: string | null, each: (r: RoleCells) => boolean | void,
): Promise<'done' | 'stopped' | 'gone'> {
  const read = db.prepare(`SELECT r.row_index, ${READ.map(() => 'json_extract(r.data, ?)').join(', ')},
      (SELECT 1 + (l.dedupe_key IS NULL) FROM enrichment_list_rows l WHERE l.dest_row_id = r.id AND l.run_id = ?)
    FROM rows r WHERE r.sheet_id = ? AND r.user_id = ? AND r.row_index > ? ORDER BY r.row_index LIMIT ?`).raw();
  const paths = READ.map(k => jsonPath(ROLE_COLUMNS[k]));
  for (let after = -1; ;) {
    if (!verifySheetOwnership(rolesSheetId, userId)) return 'gone';
    const page = read.all(...paths, runId ?? '', rolesSheetId, userId, after, HIRING_SUMMARY_READ_ROWS) as unknown[][];
    for (const row of page) {
      const [title, company, domain, posted, link] = row.slice(1, 6).map(text);
      if (each({ title, company, domain, posted, link, added: Number(row[6] ?? 0) }) === false) return 'stopped';
    }
    if (page.length < HIRING_SUMMARY_READ_ROWS) return 'done';
    after = page[page.length - 1][0] as number;
    await yieldToRequests();
  }
}

// A loop over the companies kept: other requests get in every HIRING_SUMMARY_SLICE_MS.
export function pacer(): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < HIRING_SUMMARY_SLICE_MS) return;
    await yieldToRequests();
    since = performance.now();
  };
}

export async function readRoles(
  userId: string, rolesSheetId: string, runId: string | null, opts: { batch: RolesBatch | null; cap: number },
): Promise<RolesOutcome> {
  const listed = new Set(getSheetColumns(rolesSheetId, userId, false));
  const out: RolesRead = {
    companies: new Map(), roles: 0, newRoles: 0, byName: 0, noCompany: 0, newNoKey: 0,
    missing: READ.map(k => ROLE_COLUMNS[k]).filter(c => !listed.has(c)),
  };
  const { batch, cap } = opts;
  // The domain each company name was seen with (one read: built as it goes; a batch: given).
  const domainOf = batch?.remap ?? new Map<string, string>();
  const named = new Map<string, CompanyAcc>();
  // Past the cap (a whole read): the sampled keys of every company, to count them.
  let counted = null as Set<string> | null;
  const sampled = (k: string) => keyBatch(k, HIRING_SUMMARY_COUNT_SAMPLE) === 0;
  const walked = await eachRole(userId, rolesSheetId, runId, r => {
    const key = companyKey(r.domain, r.company);
    if (!key) { out.noCompany++; return true; }
    if (counted) { if (sampled(key.key)) counted.add(key.key); return true; }
    const isNew = r.added > 0;
    out.roles++;
    if (isNew) out.newRoles++;
    if (r.added === 2) out.newNoKey++;
    if (key.byName) out.byName++;
    const plain = key.byName ? key.key.slice('name:'.length) : '';
    if (batch && keyBatch(key.byName ? domainOf.get(plain) ?? key.key : key.key, batch.of) !== batch.index) return true;
    const into = key.byName ? named : out.companies;
    let acc = into.get(key.key);
    if (!acc) {
      if (out.companies.size + named.size >= cap) {
        if (batch) return false;
        counted = new Set([...out.companies.keys(), ...named.keys(), key.key].filter(sampled));
        out.companies.clear();
        named.clear();
        return true;
      }
      acc = newAcc(key.domain);
      into.set(key.key, acc);
    }
    addRole(acc, { title: r.title, company: r.company, posted: r.posted, link: r.link, isNew });
    if (!batch && !key.byName && r.company) {
      const p = plainCompanyName(r.company);
      if (p && !domainOf.has(p)) domainOf.set(p, key.key);
    }
    return true;
  });
  if (walked === 'gone') return { gone: true };
  if (walked === 'stopped') return { overflow: cap };
  if (counted) return { overflow: Math.max(cap + 1, counted.size * HIRING_SUMMARY_COUNT_SAMPLE) };
  const pace = pacer();
  for (const [key, acc] of named) {
    const domainKey = domainOf.get(key.slice('name:'.length));
    const into = domainKey ? out.companies.get(domainKey) : undefined;
    if (into) mergeAcc(into, acc);
    else out.companies.set(key, acc);
    await pace();
  }
  return out;
}

// Before a summary in batches: the domain each company name seen with no
// domain joins, as one read finds it (the first domain whose roles carry the
// name, in Roles' order). Two reads: the names roles with no domain carry,
// then the domains of those names only, so memory grows with those names.
export async function nameRemap(userId: string, rolesSheetId: string): Promise<Map<string, string> | 'gone'> {
  const names = new Set<string>();
  const first = await eachRole(userId, rolesSheetId, null, r => {
    const key = companyKey(r.domain, r.company);
    if (key?.byName) names.add(key.key.slice('name:'.length));
  });
  const remap = new Map<string, string>();
  if (first === 'gone') return 'gone';
  if (names.size === 0) return remap;
  const second = await eachRole(userId, rolesSheetId, null, r => {
    const key = companyKey(r.domain, r.company);
    const plain = key && !key.byName ? plainCompanyName(r.company) : '';
    if (plain && names.has(plain) && !remap.has(plain)) remap.set(plain, key!.key);
  });
  return second === 'gone' ? 'gone' : remap;
}
