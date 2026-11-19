// A hiring check's summary (services/hiring-summarize.ts) and what else happens to its sheets meanwhile, and its
// batches: Roles and Companies are held for reading while it runs, so a sort of either is refused, while nothing
// that only checks for a busy sheet (a cell edit, an append) is held up; a summary that finds a sort going waits
// for it; a sheet put in the trash meanwhile stops it with nothing more written ({ gone }); a read of Roles keeps
// at most its most of companies (past it, a whole read only counts them and a batch's read stops), and the
// batches together keep each company once; summed up in batches (a most of a few companies), Companies is the
// same as one read makes, a role found by name joining its domain, and a second pass writes nothing.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
const { db, uid, ok, done, sheet } = undoKit('hiring-summarize-holds')
const { summarizeHiring } = await import('../../server/src/services/hiring-summarize')
const { readRoles } = await import('../../server/src/services/hiring-roles-read')
const { sheetBusyWith, withSheetBusy } = await import('../../server/src/lib/sheet-busy')
const { trashSheet } = await import('../../server/src/services/trash-sheets')
const { COMPANY_COLUMNS: C, ROLE_COLUMNS: R } = await import('../../server/src/lib/hiring/names')
const { HIRING_SUMMARY_READ_ROWS, HIRING_SUMMARY_WRITE_ROWS } = await import('../../server/src/lib/constants')

type Cells = Record<string, string>
const runId = uuid()
const check = { label: '2026-11-19', sinceLabel: null, runId }
const role = (i: number, companies: number): Cells => ({ [R.title]: 'SDR', [R.company]: `Company ${i % companies}`,
  [R.domain]: `c${i % companies}.com`, [R.posted]: '2026-11-18', [R.link]: `https://jobs.example/${i}` })

// A Roles sheet of `n` roles at `companies` companies (by domain), then `more`, each added by the check's run.
function rolesSheet(n: number, companies: number, more: Cells[] = []): string {
  const sid = sheet([], Object.values(R))
  const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  const list = db.prepare(`INSERT INTO enrichment_list_rows (dest_row_id,user_id,dest_sheet_id,source_row_id,
    status_column,run_id,dedupe_key) VALUES (?,?,?,'src','Roles found',?,?)`)
  db.transaction(() => {
    [...Array.from({ length: n }, (_, i) => role(i, companies)), ...more].forEach((cells, i) => {
      const id = uuid()
      insert.run(id, sid, uid, i, JSON.stringify(cells))
      list.run(id, uid, sid, runId, `key-${i}`)
    })
  }).immediate()
  return sid
}
const companiesSheet = () => sheet([], Object.values(C))
const count = (sid: string) => db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ?').pluck().get(sid) as number
const rowsOf = (sid: string): Cells[] => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index')
  .pluck().all(sid) as string[]).map(d => JSON.parse(d))
const trash = (sid: string) => {
  const out = trashSheet(uid, db.prepare('SELECT table_id FROM sheets WHERE id = ?').pluck().get(sid) as string, sid)
  assert.ok('ok' in out, JSON.stringify(out))
}
const sorting = (sid: string, work = async () => 'sorted') => withSheetBusy(sid, 'sorting', work)

await ok('while it sums up, a sort of Roles or Companies is refused; nothing else is held up', async () => {
  const roles = rolesSheet(3 * HIRING_SUMMARY_READ_ROWS, 50)
  const companies = companiesSheet()
  const going = summarizeHiring(uid, { roles, companies }, check)
  for (const sid of [roles, companies]) {
    const sort = await sorting(sid)
    assert.ok(typeof sort === 'object' && sort.busy.includes('summing up the roles per company'), JSON.stringify(sort))
    assert.equal(sheetBusyWith(sid), null, 'a cell edit or an append checks only this: it goes on')
  }
  const s = await going
  assert.ok(!('gone' in s) && s.companiesNew === 50, JSON.stringify(s))
  assert.equal(await sorting(roles), 'sorted', 'free once it is done')
})

await ok('a summary that finds a sort going waits for it, then sums up', async () => {
  const roles = rolesSheet(10, 5)
  const companies = companiesSheet()
  let sorted = false
  const sort = sorting(roles, async () => {
    await new Promise(resolve => setTimeout(resolve, 300))
    sorted = true
    return 'sorted'
  })
  const s = await summarizeHiring(uid, { roles, companies }, check)
  assert.ok(sorted, 'it started after the sort')
  assert.equal(await sort, 'sorted')
  assert.ok(!('gone' in s) && s.companiesNew === 5, JSON.stringify(s))
})

await ok('Companies put in the trash between slices: it stops, no row added after', async () => {
  const n = 3 * HIRING_SUMMARY_WRITE_ROWS
  const roles = rolesSheet(n, n)
  const companies = companiesSheet()
  let over = false
  const going = summarizeHiring(uid, { roles, companies }, check).finally(() => { over = true })
  while (count(companies) === 0 && !over) await new Promise(resolve => setImmediate(resolve))
  trash(companies)
  const at = count(companies)
  assert.ok(at > 0 && at < n, `${at} rows when it went`)
  assert.deepEqual(await going, { gone: true })
  assert.equal(count(companies), at)
})

await ok('Roles put in the trash between pages: it stops before writing anything', async () => {
  const roles = rolesSheet(3 * HIRING_SUMMARY_READ_ROWS, 10)
  const companies = companiesSheet()
  // Its first page is read before the call returns; the next one finds Roles gone.
  const going = summarizeHiring(uid, { roles, companies }, check)
  trash(roles)
  assert.deepEqual(await going, { gone: true })
  assert.equal(count(companies), 0)
})

await ok('a read keeps at most its most of companies; the batches together keep each company once', async () => {
  const roles = rolesSheet(400, 40)
  const whole = await readRoles(uid, roles, runId, { batch: null, cap: 10 })
  assert.ok('overflow' in whole && whole.overflow > 10, `past the most, a count only: ${JSON.stringify(whole)}`)
  const all = await readRoles(uid, roles, runId, { batch: null, cap: 40 })
  assert.ok('companies' in all && all.companies.size === 40 && all.roles === 400)
  const remap = new Map<string, string>()
  const kept = new Set<string>()
  for (let index = 0; index < 8; index++) {
    const part = await readRoles(uid, roles, runId, { batch: { index, of: 8, remap }, cap: 12 })
    assert.ok('companies' in part && part.companies.size <= 12, `batch ${index}`)
    assert.equal(part.roles, 400, 'every read counts every role')
    for (const k of part.companies.keys()) {
      assert.ok(!kept.has(k), k)
      kept.add(k)
    }
  }
  assert.equal(kept.size, 40)
  const over = await readRoles(uid, roles, runId, { batch: { index: 0, of: 2, remap }, cap: 3 })
  assert.deepEqual(over, { overflow: 3 }, 'a batch past its most stops')
})

await ok('in batches: the same Companies as one read, a role found by name joining its domain', async () => {
  const byName = (company: string, title: string): Cells =>
    ({ [R.title]: title, [R.company]: company, [R.domain]: '', [R.posted]: '2026-11-17', [R.link]: '' })
  const roles = rolesSheet(400, 40, [byName('Company 3 Inc.', 'AE'), byName('Nameonly LLC', 'BDR')])
  const one = companiesSheet()
  const batched = companiesSheet()
  const a = await summarizeHiring(uid, { roles, companies: one }, check)
  const b = await summarizeHiring(uid, { roles, companies: batched }, check, { maxCompanies: 4 })
  assert.ok(!('gone' in a) && a.companiesNew === 41, JSON.stringify(a))
  assert.deepEqual(b, a)
  const sorted = (sid: string) => rowsOf(sid).sort((x, y) =>
    `${x[C.domain]} ${x[C.company]}`.localeCompare(`${y[C.domain]} ${y[C.company]}`))
  assert.deepEqual(sorted(batched), sorted(one))
  const c3 = rowsOf(batched).find(r => r[C.domain] === 'c3.com')!
  assert.deepEqual([c3[C.openRoles], c3[C.titles]], ['11', 'SDR, AE'])
  const again = await summarizeHiring(uid, { roles, companies: batched }, check, { maxCompanies: 4 })
  assert.ok(!('gone' in again) && again.cellsWritten === 0 && again.companiesNew === 0, JSON.stringify(again))
})

done()
