// Runs on a test copy count under the sheet it tests (migration 076's test_copies; services/usage.ts and
// enrich-spend.ts) on a migrated throwaway DB. A real test start links its copy; the sheet's usage then has the
// copy's runs, marked on_test_copy and apart from its own column of the same name, while the test is open and after
// it is discarded and the copy gone (never as a deleted sheet), in the account's usage too, in the CSV and in
// Settings' enrichment spend. Two tests' runs of one column add up; another sheet's usage has none of them; the
// read walks the index for the sheet and for each copy; a copy open before 076 gets its link; the tested sheet's
// own delete keeps them under it.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
runMigrations()
const { readUsage, usageAsk } = await import('../../server/src/services/usage')
const { writeUsageCsv } = await import('../../server/src/services/usage-csv')
const { enrichSpend } = await import('../../server/src/services/enrich-spend')
const { startSheetTest } = await import('../../server/src/services/sheet-test-start')
const { discardSheetTest } = await import('../../server/src/services/sheet-test-end')
const { testOfSheet } = await import('../../server/src/services/sheet-test-store')

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).stack)
  }
}
const until = async (ok: () => boolean, what: string) => {
  for (const end = Date.now() + 15_000; !ok();) {
    if (Date.now() > end) throw new Error(`timed out waiting: ${what}`)
    await new Promise(r => setTimeout(r, 50))
  }
}

const uid = uuid(), tid = uuid(), sid = uuid(), other = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
for (const [id, name, pos] of [[sid, 'Leads', 0], [other, 'Other', 1]] as const) {
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
    .run(id, tid, uid, name, pos, JSON.stringify(['Name', 'Fit']))
}
for (let i = 0; i < 5; i++) {
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
    .run(uuid(), sid, uid, i, JSON.stringify({ Name: `n${i}`, Fit: '' }))
}
const AT = '2026-10-05 10:00:00'
const aiRun = (sheet: string, cost: number, at = AT) => {
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,status,created_at)
    VALUES (?,?,?,'Fit','p','m1','completed',?)`).run(id, sheet, uid, at)
  db.prepare(`INSERT INTO ai_results (id,run_id,user_id,row_index,output_value,status,cost_usd)
    VALUES (?,?,?,0,'x','completed',?)`).run(uuid(), id, uid, cost)
  return id
}
const enrichCall = (sheet: string, micro: number) => db.prepare(`INSERT INTO enrichment_calls (id,user_id,sheet_id,
  status_column,tool_id,attempt,cost_micro,created_at) VALUES (?,?,?,'Work email','t','t1',?,datetime('now'))`)
  .run(uuid(), uid, sheet, micro)
type Row = Record<string, unknown>
const ask = (sheet: string | null, q: Row = {}) => {
  const out = usageAsk(uid, sheet, { from: '2026-10-01', to: '2026-10-31', ...q })
  if ('fail' in out) throw new Error(out.message)
  return readUsage(out.ok.scope, out.ok.query)
}
const fit = (rows: Row[], onCopy: boolean) => rows.find(r => r.column === 'Fit' && r.on_test_copy === onCopy)

const own = aiRun(sid, 0.002)
enrichCall(sid, 1000)
let copy = '', copyRun = ''

await check('a test start links its copy to the sheet', async () => {
  const out = await startSheetTest(uid, sid, { rows: 3 })
  assert.ok('ok' in out, JSON.stringify(out))
  copy = out.ok.test_sheet_id
  assert.equal(db.prepare('SELECT sheet_id FROM test_copies WHERE copy_id = ?').pluck().get(copy), sid)
  copyRun = aiRun(copy, 0.01)
  enrichCall(copy, 3000)
})

const counted = (label: string) => check(label, async () => {
  const byColumn = ask(sid)
  assert.equal(byColumn.totals.runs, 2)
  assert.ok(Math.abs(byColumn.totals.ai_cost_usd - 0.012) < 1e-9, JSON.stringify(byColumn.totals))
  const rows = byColumn.rows as unknown as Row[]
  assert.equal(rows.length, 2, 'the copy\'s column apart from the sheet\'s own')
  assert.deepEqual([fit(rows, true)?.sheet_id, fit(rows, true)?.sheet_name, fit(rows, true)?.sheet_deleted,
    fit(rows, true)?.runs], [sid, 'Leads', false, 1])
  assert.equal(fit(rows, false)?.runs, 1)
  assert.equal(byColumn.rows_total, 2)
  const byRun = ask(sid, { group_by: 'run' }).rows as unknown as Row[]
  const run = byRun.find(r => r.run_id === copyRun)
  assert.deepEqual([run?.sheet_id, run?.on_test_copy], [sid, true])
  assert.equal(byRun.find(r => r.run_id === own)?.on_test_copy, false)
  assert.equal(ask(sid, { group_by: 'day' }).rows.length, 1)
  const account = ask(null).rows as unknown as Row[]
  assert.deepEqual([fit(account, true)?.sheet_id, fit(account, true)?.sheet_deleted], [sid, false])
  assert.equal(ask(other).totals.runs, 0, 'another sheet has none of them')
  const spend = await enrichSpend(uid, 7)
  const tested = spend.columns.find(c => c.onTestCopy)
  assert.deepEqual([tested?.sheetId, tested?.sheetName, tested?.calls, spend.columns.length], [sid, 'Leads', 1, 2])
})

await counted('open: the copy\'s runs count under the sheet, marked, apart from its own column')

await check('the sheet\'s read walks the index for the sheet and its copy, never the whole table', async () => {
  const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM run_usage u
    LEFT JOIN test_copies c ON c.copy_id = u.sheet_id AND c.user_id = u.user_id
    WHERE u.sheet_id IN (SELECT ? UNION ALL SELECT x.copy_id FROM test_copies x WHERE x.sheet_id = ?
      AND x.user_id = ?) AND +u.user_id = ? AND u.started_at >= ? AND u.started_at < ?`)
    .all(sid, sid, uid, uid, 'a', 'b') as
    Array<{ detail: string }>).map(p => p.detail)
  assert.ok(plan.some(d => d.includes('idx_run_usage_sheet_time')), plan.join(' | '))
  assert.ok(plan.some(d => d.includes('idx_test_copies_sheet')), plan.join(' | '))
  assert.ok(!plan.some(d => /^SCAN (u|run_usage)\b/.test(d)), plan.join(' | '))
})

await check('discarded and the copy gone: still under the sheet, never a deleted sheet', async () => {
  assert.ok('ok' in discardSheetTest(uid, sid))
  await until(() => !testOfSheet(sid, uid), 'the test ends')
  assert.equal(db.prepare('SELECT COUNT(*) FROM sheets WHERE id = ?').pluck().get(copy), 0)
})
await counted('... the same figures after the test')

await check('Settings\' spend: a call without a sheet keeps its own line next to a copy\'s', async () => {
  const callSheet = uuid()
  db.prepare('INSERT INTO call_sheets (sheet_id, user_id) VALUES (?,?)').run(callSheet, uid)
  enrichCall(callSheet, 5000)
  try {
    const spend = await enrichSpend(uid, 7)
    const call = spend.columns.find(c => c.call)
    assert.deepEqual([call?.sheetId, call?.column, call?.onTestCopy, call?.calls], [null, null, false, 1])
    assert.equal(spend.columns.find(c => c.onTestCopy)?.sheetId, sid)
  } finally { db.prepare('DELETE FROM enrichment_calls WHERE sheet_id = ?').run(callSheet) }
})

await check('the CSV says which runs were on sample rows', async () => {
  let body = ''
  const res = {
    destroyed: false, setHeader: () => {}, write: (c: string) => { body += c; return true }, end: () => {},
    once: () => {}, off: () => {},
  }
  const out = usageAsk(uid, sid, { from: '2026-10-01', to: '2026-10-31', group_by: 'run' })
  if ('fail' in out) throw new Error(out.message)
  await writeUsageCsv(res as never, out.ok.scope, 'run', out.ok.name)
  const lines = body.split('\r\n')
  assert.ok(lines[0].includes('"Deleted","On sample rows","Kind"'), lines[0])
  assert.ok(lines.find(l => l.endsWith(`"${copyRun}"`))?.includes(',"Leads","Fit","","yes","AI",'), body)
  assert.ok(lines.find(l => l.endsWith(`"${own}"`))?.includes(',"Leads","Fit","","","AI",'), body)
})

await check('a second test\'s runs of the column add up with the first\'s', async () => {
  const out = await startSheetTest(uid, sid, { rows: 2 })
  assert.ok('ok' in out, JSON.stringify(out))
  aiRun(out.ok.test_sheet_id, 0.02, '2026-10-06 10:00:00')
  discardSheetTest(uid, sid)
  await until(() => !testOfSheet(sid, uid), 'the second test ends')
  const rows = ask(sid).rows as unknown as Row[]
  assert.deepEqual([rows.length, fit(rows, true)?.runs, fit(rows, false)?.runs], [2, 2, 1])
})

await check('another user\'s link never brings this user\'s runs in or moves them', async () => {
  const stranger = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(stranger, 'x')
  db.prepare('INSERT INTO test_copies (copy_id, sheet_id, user_id) VALUES (?,?,?)').run(other, sid, stranger)
  const run = aiRun(other, 0.005)
  try {
    assert.equal(ask(sid).totals.runs, 3)
    const rows = ask(other, { group_by: 'run' }).rows as unknown as Row[]
    assert.deepEqual(rows.map(r => [r.run_id, r.sheet_id, r.on_test_copy]), [[run, other, false]])
  } finally { db.prepare('DELETE FROM test_copies WHERE copy_id = ?').run(other) }
})

await check('a copy open before 076 gets its link', async () => {
  const sql = fs.readFileSync(new URL('../../server/src/db/migrations/076_test_copies.sql', import.meta.url), 'utf8')
  const backfill = sql.slice(sql.indexOf('-- Copies open when this runs.'))
  const open = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,test_of) VALUES (?,?,?,?,?)').run(open, tid, uid, 'Other',
    other)
  db.prepare('DELETE FROM test_copies WHERE copy_id = ?').run(open)
  db.exec(backfill)
  assert.equal(db.prepare('SELECT sheet_id FROM test_copies WHERE copy_id = ?').pluck().get(open), other)
  db.prepare('DELETE FROM sheets WHERE id = ?').run(open)
})

await check('the tested sheet deleted: its copies\' runs stay under it, as a deleted sheet\'s', async () => {
  db.prepare('DELETE FROM sheets WHERE id = ?').run(sid)
  const account = ask(null).rows as unknown as Row[]
  assert.deepEqual([fit(account, true)?.sheet_id, fit(account, true)?.sheet_deleted, fit(account, true)?.runs],
    [sid, true, 2])
  assert.equal(account.filter(r => r.sheet_id === sid).length, 2)
})

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('All usage-test-copy checks passed.')
process.exitCode = 0
