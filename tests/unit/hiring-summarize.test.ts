// A hiring check's summary (services/hiring-summarize.ts, hiring-roles-read.ts) on a migrated throwaway DB: one
// Companies row per company, its roles grouped by domain; a role with no domain grouped by its company name made
// plain (joining the company found by domain when the names match), counted in the problems; a role with neither
// left out; the first check names nothing new, a later one names what its run added and clears the rest; a
// company whose roles are gone shows 0; a row the person deleted is made again and one they edited is still
// found; a second pass writes no cell; a deleted column is left out; a full sheet says so; new roles with no
// key to tell them apart are said.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
process.env.MAX_ROWS_PER_SHEET = '14'
const { undoKit } = await import('./run-undo-kit')
const { db, uid, ok, done, sheet } = undoKit('hiring-summarize')
const { summarizeHiring } = await import('../../server/src/services/hiring-summarize')
const { COMPANY_COLUMNS: C, ROLE_COLUMNS: R } = await import('../../server/src/lib/hiring/names')

const roles = sheet([], Object.values(R))
const companies = sheet([{ [C.openRoles]: 'my note' }], Object.values(C))
const sheets = { roles, companies }
let index = 0
const role = (company: string, domain: string, title: string, posted: string, runId: string, link = true) => {
  const id = uuid()
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)').run(id, roles, uid, index++,
    JSON.stringify({ [R.title]: title, [R.company]: company, [R.domain]: domain, [R.posted]: posted,
      [R.link]: link ? `https://jobs.example/${index}` : '' }))
  // As a keep-mode add records it: the result's key, none when it had no link.
  db.prepare(`INSERT INTO enrichment_list_rows (dest_row_id,user_id,dest_sheet_id,source_sheet_id,source_row_id,
    status_column,run_id,dedupe_key) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, uid, roles, null, 'src', 'Roles found', runId, link ? `key-${index}` : null)
  return id
}
const sum = async (check: { label: string; sinceLabel: string | null; runId: string | null }) => {
  const s = await summarizeHiring(uid, sheets, check)
  assert.ok(!('gone' in s), 'both sheets are there')
  return s
}
type Row = Record<string, string>
const rows = (): Row[] => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
  .all(companies) as string[]).map(d => JSON.parse(d))
const byDomain = (d: string) => rows().find(r => r[C.domain] === d)
const byCompany = (n: string) => rows().find(r => r[C.company] === n)

const r1 = uuid(), r2 = uuid(), r3 = uuid()
role('Acme', 'https://www.acme.com/careers', 'SDR', '2026-11-02', r1)
role('Acme', 'acme.com', 'BDR', '2026-11-05T09:00:00Z', r1)
const bluefin = role('Bluefin Data', 'bluefin.io', 'SDR', '2026-11-01', r1)
role('Quillmark', 'quillmark.com', 'SDR', '2026-11-03', r1)
role('Quillmark Inc.', '', 'AE', '2026-11-04', r1)
role('Solo Corp LLC', '', 'SDR', '2026-11-04', r1)
role('', '', 'SDR', '2026-11-04', r1)
const first = { label: '2026-11-11', sinceLabel: null, runId: r1 }

await ok('the first check: one row per company, grouped by domain, else by name; what was left out said', async () => {
  const s = await sum(first)
  assert.equal(s.roles, 6)
  assert.equal(s.newRoles, 6)
  assert.equal(s.companiesNew, 4)
  assert.equal(s.companiesHiringMore, 0)
  assert.ok(s.problems.includes('2 roles had no domain, so they were summed up by company name.'), s.problems.join())
  assert.ok(s.problems.includes('1 role had no company name or domain: left out.'), s.problems.join())
  const acme = byDomain('acme.com')!
  assert.deepEqual([acme[C.company], acme[C.openRoles], acme[C.titles], acme[C.newest], acme[C.firstSeen]],
    ['Acme', '2', 'SDR, BDR', '2026-11-05', '2026-11-11'])
  assert.equal(acme[C.newSince], '')
  assert.equal(acme[C.newRoles], '')
  assert.equal(byDomain('quillmark.com')![C.openRoles], '2', 'the role with no domain joined its company')
  const solo = byCompany('Solo Corp LLC')!
  assert.deepEqual([solo[C.domain], solo[C.openRoles]], ['', '1'])
  assert.equal(rows()[0][C.openRoles], 'my note', 'a row with no company is left alone')
})

await ok('a second pass writes no cell and adds no row', async () => {
  const before = rows().length
  const s = await sum(first)
  assert.equal(s.cellsWritten, 0)
  assert.equal(s.companiesNew, 0)
  assert.equal(rows().length, before)
})

const second = { label: '2026-11-18', sinceLabel: '2026-11-11', runId: r2 }
await ok('a later check: what its run added is named, a company with no roles left shows 0', async () => {
  role('Acme', 'acme.com', 'AE', '2026-11-17', r2)
  role('Solo Corp', '', 'BDR', '2026-11-17', r2)
  role('Copperleaf Systems', 'copperleaf.dev', 'SDR', '2026-11-16', r2)
  db.prepare('DELETE FROM rows WHERE id = ?').run(bluefin)
  const s = await sum(second)
  assert.equal(s.newRoles, 3)
  assert.equal(s.companiesNew, 1)
  assert.equal(s.companiesHiringMore, 2)
  const acme = byDomain('acme.com')!
  assert.deepEqual([acme[C.openRoles], acme[C.newRoles], acme[C.newSince], acme[C.firstSeen]],
    ['3', '1', 'New since Nov 11: 1 role (AE)', '2026-11-11'])
  assert.equal(acme[C.links].split('\n')[0], 'https://jobs.example/8', 'the newest link first')
  assert.equal(byCompany('Solo Corp LLC')![C.openRoles], '2', 'grouped by its plain name')
  const blue = byDomain('bluefin.io')!
  assert.deepEqual([blue[C.openRoles], blue[C.titles], blue[C.links], blue[C.newRoles]], ['0', '', '', ''])
  const copper = byDomain('copperleaf.dev')!
  assert.deepEqual([copper[C.firstSeen], copper[C.newRoles]], ['2026-11-18', '1'])
})

await ok('a row the person deleted is made again; one they edited is still found', async () => {
  db.prepare('DELETE FROM rows WHERE sheet_id = ? AND json_extract(data, ?) = ?')
    .run(companies, `$."${C.domain}"`, 'copperleaf.dev')
  db.prepare('UPDATE rows SET data = json_set(data, ?, ?) WHERE sheet_id = ? AND json_extract(data, ?) = ?')
    .run(`$."${C.company}"`, 'ACME (our best lead)', companies, `$."${C.domain}"`, 'acme.com')
  const s = await sum(second)
  assert.equal(s.companiesNew, 1)
  assert.equal(s.cellsWritten, 0)
  assert.equal(rows().filter(r => r[C.domain] === 'acme.com').length, 1)
  assert.equal(byDomain('copperleaf.dev')![C.openRoles], '1')
})

await ok('a check with nothing new clears the New cells, and writes only those', async () => {
  const s = await sum({ label: '2026-11-19', sinceLabel: '2026-11-18', runId: r3 })
  assert.equal(s.newRoles, 0)
  assert.equal(s.companiesHiringMore, 0)
  assert.ok(rows().every(r => !r[C.newRoles] && !r[C.newSince]))
  assert.equal(s.cellsWritten, 2 * 3, 'the two New cells of Acme, Solo Corp and Copperleaf')
})

await ok('a Companies column the person deleted is left out and said', async () => {
  const order = Object.values(C).filter(c => c !== C.links)
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(order), companies)
  role('Acme', 'acme.com', 'CSM', '2026-11-19', r3)
  const s = await sum({ label: '2026-11-19', sinceLabel: '2026-11-18', runId: r3 })
  assert.ok(s.problems.includes(`Companies has no "${C.links}" column: left out.`), s.problems.join())
  assert.equal(s.cellsWritten, 5, 'Open roles, Role titles, Newest posted, New since and New roles of Acme')
  assert.ok(!byDomain('acme.com')![C.links].includes('jobs.example/12'))
})

await ok('a full Companies sheet adds what fits and says how many were not', async () => {
  const filler = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  const room = 14 - rows().length - 1
  for (let i = 0; i < room; i++) filler.run(uuid(), companies, uid, 100 + i, '{}')
  role('Harborview Health', 'harborview.org', 'SDR', '2026-11-19', r3)
  role('Northwind Labs', 'northwind.ai', 'SDR', '2026-11-19', r3)
  const s = await sum({ label: '2026-11-19', sinceLabel: '2026-11-18', runId: r3 })
  assert.equal(s.companiesNew, 1)
  assert.ok(s.problems.includes("Companies is full: 1 company wasn't added."), s.problems.join())
  assert.equal(rows().length, 14)
})

await ok('new roles with no key to tell them apart are said (a later check can add them again)', async () => {
  const r4 = uuid()
  role('Acme', 'acme.com', 'SE', '2026-11-20', r4, false)
  role('Acme', 'acme.com', 'SE II', '2026-11-20', r4, false)
  const s = await sum({ label: '2026-11-20', sinceLabel: '2026-11-19', runId: r4 })
  const said = '2 new roles had no link or job id to tell them apart, so a later check can add them again.'
  assert.ok(s.problems.includes(said), s.problems.join())
})

done()
