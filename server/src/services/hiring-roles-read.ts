// A check's first summary step (services/hiring-summarize.ts): the Roles
// sheet read a slice at a time, in its order, other requests served between
// slices, each role folded into its company (lib/hiring/summary.ts). A role
// counts as new when this check's run added it. Memory grows with the
// companies, a few hundred bytes each, never with a company's roles.
import { db } from '../lib/db';
import { getSheetColumns, jsonPath } from '../lib/sql-helpers';
import { yieldToRequests } from '../lib/slices';
import { HIRING_SUMMARY_READ_ROWS } from '../lib/constants';
import { companyKey, plainCompanyName } from '../lib/hiring/company-key';
import { ROLE_COLUMNS } from '../lib/hiring/names';
import { addRole, mergeAcc, newAcc, type CompanyAcc } from '../lib/hiring/summary';

export interface RolesRead {
  companies: Map<string, CompanyAcc>;   // by company key, in the order first seen
  roles: number; newRoles: number;
  byName: number;                       // roles with no domain, summed up by company name
  noCompany: number;                    // roles with neither: left out
  missing: string[];                    // Roles columns the summary reads that aren't there
}

const READ = ['title', 'company', 'domain', 'posted', 'link'] as const;

export async function readRoles(userId: string, rolesSheetId: string, runId: string | null): Promise<RolesRead> {
  const listed = new Set(getSheetColumns(rolesSheetId, userId, false));
  const missing = READ.map(k => ROLE_COLUMNS[k]).filter(c => !listed.has(c));
  const out: RolesRead = { companies: new Map(), roles: 0, newRoles: 0, byName: 0, noCompany: 0, missing };
  const read = db.prepare(`SELECT r.row_index, ${READ.map(() => 'json_extract(r.data, ?)').join(', ')},
      EXISTS (SELECT 1 FROM enrichment_list_rows l WHERE l.dest_row_id = r.id AND l.run_id = ?)
    FROM rows r WHERE r.sheet_id = ? AND r.user_id = ? AND r.row_index > ? ORDER BY r.row_index LIMIT ?`).raw();
  const paths = READ.map(k => jsonPath(ROLE_COLUMNS[k]));
  // The domain each company name was seen with: its roles with no domain join that company.
  const domainOf = new Map<string, string>();
  const named = new Map<string, CompanyAcc>();
  const text = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
  for (let after = -1; ;) {
    const page = read.all(...paths, runId ?? '', rolesSheetId, userId, after, HIRING_SUMMARY_READ_ROWS) as unknown[][];
    for (const row of page) {
      const [title, company, domain, posted, link] = row.slice(1, 6).map(text);
      const key = companyKey(domain, company);
      if (!key) { out.noCompany++; continue; }
      const isNew = row[6] === 1;
      const into = key.byName ? named : out.companies;
      let acc = into.get(key.key);
      if (!acc) { acc = newAcc(key.domain); into.set(key.key, acc); }
      addRole(acc, { title, company, posted, link, isNew });
      if (!key.byName && company) {
        const plain = plainCompanyName(company);
        if (plain && !domainOf.has(plain)) domainOf.set(plain, key.key);
      }
      out.roles++;
      if (isNew) out.newRoles++;
      if (key.byName) out.byName++;
    }
    if (page.length < HIRING_SUMMARY_READ_ROWS) break;
    after = page[page.length - 1][0] as number;
    await yieldToRequests();
  }
  for (const [key, acc] of named) {
    const domainKey = domainOf.get(key.slice('name:'.length));
    const into = domainKey ? out.companies.get(domainKey) : undefined;
    if (into) mergeAcc(into, acc);
    else out.companies.set(key, acc);
  }
  return out;
}
