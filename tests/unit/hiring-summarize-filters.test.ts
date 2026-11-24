// A hiring check's summary with the table's filters on Companies (services/hiring-summarize-write.ts,
// lib/hiring/company-filters.ts) on a migrated throwaway DB: a company with fewer matching roles than the most, or
// whose website is left out, gets no row and is counted as kept off, while its roles stay in Roles; one that
// reaches the most at a later check gets its row then (First seen that day, a new company); a row already on
// Companies (made by hand, or one whose roles were deleted) is kept up to date, never removed or blanked; a full
// sheet counts only the companies the filters keep; the batched summary keeps off the same companies.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
process.env.MAX_ROWS_PER_SHEET = '7'
const { undoKit } = await import('./run-undo-kit')
const { db, uid, ok, done, sheet } = undoKit('hiring-summarize-filters')
const { summarizeHiring } = await import('../../server/src/services/hiring-summarize')
const { companyKeep } = await import('../../server/src/lib/hiring/company-filters')
const { COMPANY_COLUMNS: C, ROLE_COLUMNS: R } = await import('../../server/src/lib/hiring/names')

type Row = Record<string, string>
function pair() {
  const roles = sheet([], Object.values(R))
  const companies = sheet([], Object.values(C))
  let index = 0
  const role = (company: string, domain: string, title: string, runId: string) => {
    const id = uuid()
    db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)').run(id, roles, uid,
      index++, JSON.stringify({ [R.title]: title, [R.company]: company, [R.domain]: domain, [R.posted]: '2026-11-20',
        [R.link]: `https://jobs.example/${roles}/${index}` }))
    db.prepare(`INSERT INTO enrichment_list_rows (dest_row_id,user_id,dest_sheet_id,source_sheet_id,source_row_id,
      status_column,run_id,dedupe_key) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, uid, roles, null, 'src', 'Roles found', runId, `key-${roles}-${index}`)
    return id
  }
  const rows = (): Row[] => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
    .all(companies) as string[]).map(d => JSON.parse(d))
  const roleCount = () => db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ?').pluck().get(roles) as number
  return { roles, companies, role, rows, roleCount }
}
const keep = companyKeep({ minRoles: 2, leaveOutCompanies: ['https://www.ford.com/careers'] })

const a = pair()
const r1 = uuid(), r2 = uuid()
a.role('Acme', 'acme.io', 'SDR', r1)
const acmeBdr = a.role('Acme', 'acme.io', 'BDR', r1)
a.role('Bluefin Data', 'bluefin.io', 'SDR', r1)
for (const t of ['SDR', 'BDR', 'AE']) a.role('Ford', 'ford.com', t, r1)
a.role('Quillmark', 'quillmark.com', 'SDR', r1)
a.role('Quillmark Inc.', '', 'AE', r1)
a.role('Solo Corp', '', 'SDR', r1)
a.role('Solo Corp LLC', '', 'BDR', r1)
const sum = async (s: ReturnType<typeof pair>, check: { label: string; sinceLabel: string | null; runId: string },
  maxCompanies?: number) => {
  const out = await summarizeHiring(uid, { roles: s.roles, companies: s.companies }, { ...check, keep },
    maxCompanies ? { maxCompanies } : {})
  assert.ok(!('gone' in out), 'both sheets are there')
  return out
}
const names = (s: ReturnType<typeof pair>) => s.rows().map(r => `${r[C.company]} ${r[C.openRoles]}`).sort()

await ok('under the most or left out: no row, counted as kept off; their roles stay in Roles', async () => {
  const s = await sum(a, { label: '2026-11-11', sinceLabel: null, runId: r1 })
  assert.deepEqual(names(a), ['Acme 2', 'Quillmark 2', 'Solo Corp 2'])
  assert.equal(s.companiesNew, 3)
  assert.equal(s.companiesKeptOff, 2, 'Bluefin (1 role) and Ford (left out)')
  assert.equal(s.roles, 10)
  assert.equal(a.roleCount(), 10)
})

await ok('a company that reaches the most at a later check gets its row then, as a new company', async () => {
  a.role('Bluefin Data', 'bluefin.io', 'AE', r2)
  const s = await sum(a, { label: '2026-11-18', sinceLabel: '2026-11-11', runId: r2 })
  assert.equal(s.companiesNew, 1)
  assert.equal(s.companiesKeptOff, 1, 'Ford, still left out')
  const blue = a.rows().find(r => r[C.domain] === 'bluefin.io')!
  assert.deepEqual([blue[C.openRoles], blue[C.firstSeen], blue[C.newRoles], blue[C.newSince]],
    ['2', '2026-11-18', '1', 'New since Nov 11: 1 role (AE)'])
})

await ok('a row already there is kept up to date: one whose roles fell under the most, one made by hand', async () => {
  db.prepare('DELETE FROM rows WHERE id = ?').run(acmeBdr)
  // The person adds Ford by hand: a row the filters would keep off is theirs to keep.
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)').run(uuid(), a.companies,
    uid, 50, JSON.stringify({ [C.company]: 'Ford', [C.domain]: 'ford.com' }))
  const s = await sum(a, { label: '2026-11-19', sinceLabel: '2026-11-18', runId: uuid() })
  assert.deepEqual(names(a), ['Acme 1', 'Bluefin Data 2', 'Ford 3', 'Quillmark 2', 'Solo Corp 2'])
  assert.equal(s.companiesKeptOff, 0)
  assert.equal(s.companiesNew, 0)
})

await ok('a full Companies sheet counts only the companies the filters keep', async () => {
  const r3 = uuid()
  for (const [name, domain] of [['Harborview', 'harborview.org'], ['Northwind', 'northwind.ai']]) {
    a.role(name, domain, 'SDR', r3)
    a.role(name, domain, 'BDR', r3)
  }
  a.role('Copperleaf', 'copperleaf.dev', 'SDR', r3)
  // 5 rows, 7 at most: room for one more row; 2 companies the filters keep, Copperleaf kept off (1 role).
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
    .run(uuid(), a.companies, uid, 60, '{}')
  const s = await sum(a, { label: '2026-11-20', sinceLabel: '2026-11-19', runId: r3 })
  assert.equal(s.companiesNew, 1)
  assert.equal(s.companiesKeptOff, 1)
  assert.ok(s.problems.includes("Companies is full: 1 company wasn't added."), s.problems.join())
})

await ok('the batched summary keeps off the same companies', async () => {
  const b = pair()
  const r = uuid()
  // 12 companies: company i has (i % 3) + 1 roles; every fourth is left out by website.
  const left: string[] = []
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j <= i % 3; j++) b.role(`Co ${i}`, `co${i}.io`, `Role ${j}`, r)
    if (i % 4 === 0) left.push(`co${i}.io`)
  }
  const many = companyKeep({ minRoles: 2, leaveOutCompanies: left })
  const out = await summarizeHiring(uid, { roles: b.roles, companies: b.companies },
    { label: '2026-11-11', sinceLabel: null, runId: r, keep: many }, { maxCompanies: 3 })
  assert.ok(!('gone' in out))
  const want = Array.from({ length: 12 }, (_, i) => i).filter(i => i % 3 >= 1 && i % 4 !== 0).map(i => `co${i}.io`)
  assert.deepEqual(b.rows().map(x => x[C.domain]).sort(), want.sort())
  assert.equal(out.companiesNew, want.length)
  assert.equal(out.companiesKeptOff, 12 - want.length)
})

done()
