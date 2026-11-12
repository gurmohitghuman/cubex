// The full error lookup behind row_ids with include_status
// (services/run-cell-errors.ts) stays bounded on a column with thousands of
// runs: it reads only the newest runs its statement budget can reach, so a
// failure recorded only in an older run reads the cell's own words, a failure
// in the newest run reads the run's whole message, and one failed row on a
// column whose runs hold no result at it answers well within the time cap.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import selMod from '../../server/src/services/row-selection'
import constMod from '../../server/src/lib/constants-query'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { queryRows } = selMod as typeof import('../../server/src/services/row-selection')
const { RUN_ERROR_CALLS } = constMod as typeof import('../../server/src/lib/constants-query')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')

// A sheet whose rows all failed on the HTTP API column Ping, and `runs` runs on
// it, oldest first, one a second, each with a result at a row of its own past
// the sheet's (as auto-run's batches); results[k] = the rows run k recorded failing.
function column(rows: number, runs: number, results: Record<number, number[]>) {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, JSON.stringify(['Company', 'Ping']))
  const ids = Array.from({ length: rows }, () => uuid())
  db.transaction(() => {
    ids.forEach((id, i) => db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
      .run(id, sid, uid, i, JSON.stringify({ Company: `C${i}`, Ping: '❌ Failed' })))
    const run = db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,created_at)
      VALUES (?,?,?,'{}','completed','Ping',datetime('2026-01-01', '+' || ? || ' seconds'))`)
    const res = db.prepare(`INSERT INTO http_results (id,run_id,user_id,row_index,status,error_message)
      VALUES (?,?,?,?,?,?)`)
    for (let k = 0; k < runs; k++) {
      const runId = uuid()
      run.run(runId, sid, uid, k)
      res.run(uuid(), runId, uid, rows + k, 'completed', null)
      for (const i of results[k] ?? []) res.run(uuid(), runId, uid, i, 'failed', `HTTP 503 from run ${k} at row ${i}`)
    }
  }).immediate()
  return { sid, ids }
}
async function errorsOf(sid: string, ids: string[]): Promise<string[]> {
  const r = await queryRows(sid, uid, { after: -1, returnMode: 'rows', includeStatus: true, rowIds: ids })
  assert.ok('ok' in r, JSON.stringify(r))
  return (r.ok.rows as Array<{ data: { Ping: { error: string } } }>).map(x => x.data.Ping.error)
}

async function main() {
  await check('only the newest runs the budget reaches are read: an older failure keeps the cell\'s words',
    async () => {
      const runs = RUN_ERROR_CALLS + 10
      const C = column(2, runs, { 0: [0], [runs - 1]: [1] })
      assert.deepEqual(await errorsOf(C.sid, C.ids), ['Failed', `HTTP 503 from run ${runs - 1} at row 1`])
    })

  await check('one failed row on a column of 60,000 runs with no result at it answers within the cap', async () => {
    const C = column(1, 60_000, {})
    await errorsOf(C.sid, C.ids)   // warm
    const t0 = performance.now()
    assert.deepEqual(await errorsOf(C.sid, C.ids), ['Failed'])
    const ms = performance.now() - t0
    // The look stops at RUN_ERROR_CALLS statements or RUN_ERROR_MS (50 ms). Before it was bounded, this read
    // walked every run: 0.4 s here, 1.2 s on a database with statistics.
    assert.ok(ms < 250, `${ms.toFixed(0)} ms`)
  })

  if (failures > 0) { console.error(`${failures} run-cell-errors assertion(s) failed`); process.exit(1) }
  console.log('All run-cell-errors assertions passed.')
}
main().catch(e => { console.error(e); process.exit(1) })
