// A physical sort runs in slices and is journaled so a restart finishes it
// (services/sheet-sort.ts, lib/sort-plan.ts, migration 004). Pins: a sort
// orders the rows, results follow their rows and orphaned results are deleted,
// and the fence moves once, at the end; a sort interrupted at any stage,
// part-way through that stage, comes out the same after resumeSorts.
import assert from 'node:assert/strict'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import sortMod from '../../server/src/services/sheet-sort'
import planMod from '../../server/src/lib/sort-plan'
import resultsMod from '../../server/src/lib/sort-results'
import orderMod from '../../server/src/lib/sort-order'
import busyMod from '../../server/src/lib/sheet-busy'
import { v4 as uuid } from 'uuid'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { physicalSortSheet, resumeSorts } = sortMod as typeof import('../../server/src/services/sheet-sort')
const P = planMod as typeof import('../../server/src/lib/sort-plan')
const { parkResults, mapResults } = resultsMod as typeof import('../../server/src/lib/sort-results')
const { sortedOrder } = orderMod as typeof import('../../server/src/lib/sort-order')
const { sheetBusyWith } = busyMod as typeof import('../../server/src/lib/sheet-busy')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const idle = async (sid: string) => { while (sheetBusyWith(sid)) await new Promise(r => setTimeout(r, 5)) }

// Letters only, so plain string order agrees with the sort's natural order
// (which compares runs of digits as numbers).
const key = () => Array.from({ length: 4 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')

// A sheet of n rows with a random sort key, an AI and an HTTP run with results
// on some rows, and results whose row is gone (one past the end, one legacy
// negative sentinel). Returns the sheet and result → row id links to check.
function sortFixture(n: number) {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, '["k"]')
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  const ai = uuid(), http = uuid()
  db.transaction(() => {
    for (let i = 0; i < n; i++) ins.run(uuid(), sid, uid, i * 2, JSON.stringify({ k: key() }))
    db.prepare("INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status) VALUES (?,?,?,'o','p','completed')").run(ai, sid, uid)
    db.prepare("INSERT INTO http_runs (id,sheet_id,user_id,config,status) VALUES (?,?,?,'{}','completed')").run(http, sid, uid)
    for (let i = 0; i < n; i += 3) db.prepare('INSERT INTO ai_results (id,run_id,user_id,row_index) VALUES (?,?,?,?)').run(uuid(), ai, uid, i * 2)
    for (let i = 0; i < n; i += 5) db.prepare('INSERT INTO http_results (id,run_id,user_id,row_index) VALUES (?,?,?,?)').run(uuid(), http, uid, i * 2)
    db.prepare('INSERT INTO http_results (id,run_id,user_id,row_index) VALUES (?,?,?,?)').run(uuid(), http, uid, n * 2 + 1)
    db.prepare('INSERT INTO http_results (id,run_id,user_id,row_index) VALUES (?,?,?,?)').run(uuid(), http, uid, -7)
  })()
  const links = db.prepare(`
    SELECT 'ai' AS t, res.id AS res, r.id AS row FROM ai_results res JOIN rows r ON r.sheet_id = ? AND r.row_index = res.row_index WHERE res.run_id = ?
    UNION ALL SELECT 'http', res.id, r.id FROM http_results res JOIN rows r ON r.sheet_id = ? AND r.row_index = res.row_index WHERE res.run_id = ?
  `).all(sid, ai, sid, http) as Array<{ t: string; res: string; row: string }>
  return { sid, links, n }
}

function checkSorted(f: ReturnType<typeof sortFixture>, rgBefore: number) {
  const rows = db.prepare('SELECT id, row_index, json_extract(data, \'$.k\') AS k FROM rows WHERE sheet_id = ? ORDER BY row_index').all(f.sid) as Array<{ id: string; row_index: number; k: string }>
  assert.equal(rows.length, f.n)
  rows.forEach((r, i) => assert.equal(r.row_index, i, 'rows sit at 0…n-1'))
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].k <= rows[i].k, 'ascending by k')
  const at = new Map(rows.map(r => [r.row_index, r.id]))
  for (const l of f.links) {
    const table = l.t === 'ai' ? 'ai_results' : 'http_results'
    const { row_index } = db.prepare(`SELECT row_index FROM ${table} WHERE id = ?`).get(l.res) as { row_index: number }
    assert.equal(at.get(row_index), l.row, `${l.t} result follows its row`)
  }
  const httpCount = (db.prepare('SELECT COUNT(*) AS c FROM http_results WHERE run_id IN (SELECT id FROM http_runs WHERE sheet_id = ?)').get(f.sid) as { c: number }).c
  assert.equal(httpCount, f.links.filter(l => l.t === 'http').length, 'orphaned results are deleted')
  assert.equal(db.prepare('SELECT 1 FROM sort_jobs WHERE sheet_id = ?').get(f.sid), undefined, 'journal dropped')
  const { row_generation } = db.prepare('SELECT row_generation FROM sheets WHERE id = ?').get(f.sid) as { row_generation: number }
  assert.ok(row_generation > rgBefore, 'fence moved')
}

const rg = (sid: string) => (db.prepare('SELECT row_generation FROM sheets WHERE id = ?').get(sid) as { row_generation: number }).row_generation

await ok('sort: order, results follow, orphans deleted, one fence bump', async () => {
  const f = sortFixture(12_000)
  const before = rg(f.sid)
  const out = await physicalSortSheet(f.sid, uid, 'k', 'asc')
  assert.deepEqual(out, { ok: true, rowsReordered: f.n })
  checkSorted(f, before)
  assert.equal(rg(f.sid), before + 1)
})

// Journal a sort and do `partial` of it by hand, as if a restart cut it short.
async function interruptedSort(stopAt: P.SortStage, partial: (plan: P.SortPlan, sid: string) => Promise<void>) {
  const f = sortFixture(11_000)
  const before = rg(f.sid)
  const rows = db.prepare("SELECT rowid AS rid, row_index, json_extract(data, '$.k') AS k FROM rows WHERE sheet_id = ? ORDER BY row_index").all(f.sid) as Array<{ rid: number; row_index: number; k: string }>
  const order = await sortedOrder(rows.map(r => r.k), 'asc')
  const base = rows[rows.length - 1].row_index + 1
  const { plan } = P.buildPlan(rows.map(r => r.rid), rows.map(r => r.row_index), order, base)
  await P.savePlan(f.sid, uid, plan)
  await partial(plan, f.sid)
  P.setSortStage(f.sid, stopAt)
  resumeSorts()
  assert.ok(stopAt === 'planning' || sheetBusyWith(f.sid), 'sheet is busy from the first tick')
  await idle(f.sid)
  if (stopAt === 'planning') {
    assert.equal(db.prepare('SELECT 1 FROM sort_jobs WHERE sheet_id = ?').get(f.sid), undefined)
    return
  }
  checkSorted(f, before)
}
const half = (plan: P.SortPlan, sql: string, arg: (i: number) => number[]) => {
  const st = db.prepare(sql)
  db.transaction(() => { for (let i = 0; i < plan.rowIds.length / 2; i++) st.run(...arg(i)) })()
}
const up = (plan: P.SortPlan) => half(plan, 'UPDATE rows SET row_index = ? WHERE rowid = ?', i => [plan.base + plan.newAt[i], plan.rowIds[i]])

await ok('resume: planning stage is dropped, rows untouched', () => interruptedSort('planning', async () => {}))
await ok('resume: half-way through moving rows up', () => interruptedSort('moving', async plan => up(plan)))
await ok('resume: half-way through parking results', () => interruptedSort('parking', async (plan, sid) => {
  await P.moveRowsUp(plan)
  db.prepare('UPDATE ai_results SET row_index = row_index + ? WHERE run_id IN (SELECT id FROM ai_runs WHERE sheet_id = ?)').run(2 ** 40, sid)
}))
await ok('resume: half-way through mapping results', () => interruptedSort('mapping', async (plan, sid) => {
  await P.moveRowsUp(plan); await parkResults(sid, uid)
  // Map the AI results only, as if the restart came between the two tables.
  const keepHttp = db.prepare('SELECT id, row_index FROM http_results WHERE run_id IN (SELECT id FROM http_runs WHERE sheet_id = ?)').all(sid) as Array<{ id: string; row_index: number }>
  await mapResults(sid, uid, P.positionMapOf(plan))
  for (const r of keepHttp) db.prepare('UPDATE http_results SET row_index = ? WHERE id = ?').run(r.row_index, r.id)
}))
await ok('resume: half-way through moving rows down', () => interruptedSort('shifting', async (plan, sid) => {
  await P.moveRowsUp(plan); await parkResults(sid, uid); await mapResults(sid, uid, P.positionMapOf(plan))
  half(plan, 'UPDATE rows SET row_index = row_index - ? WHERE rowid = ?', i => [plan.base, plan.rowIds[i]])
}))

if (failures > 0) { console.error(`${failures} sort-recovery assertion(s) failed`); process.exit(1) }
console.log('All sort-recovery assertions passed.')
