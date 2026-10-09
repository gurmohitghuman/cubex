// What a run sets off through auto-run (services/autorun-estimate.ts
// afterWriting), against a migrated throwaway DB: the auto-runs that read a
// column the run writes, then the ones those set off in turn, never the run's
// own column, never one that reads none of them. HTTP API columns only, so no
// treg catalog is asked.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import estMod from '../../server/src/services/autorun-estimate'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { estimateAutorunRows } = estMod as typeof import('../../server/src/services/autorun-estimate')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

const uid = uuid(), tableId = uuid(), sheetId = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
db.prepare('INSERT INTO sheets (id, table_id, user_id, name) VALUES (?,?,?,?)').run(sheetId, tableId, uid, 'S')
const httpConfig = JSON.stringify({
  requestConfig: { method: 'POST', url: 'https://x.test', headers: {}, body: '{}' }, responseMapping: [],
})
// An HTTP API column with auto-run on, reading `reads`, writing `outputs`.
function column(status: string, reads: string[], outputs: string[] = [], rowCap = 1000) {
  const runId = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name)
    VALUES (?,?,?,?, 'completed', ?)`).run(runId, sheetId, uid, httpConfig, status)
  for (const o of outputs) {
    db.prepare(`INSERT INTO http_column_associations (id, sheet_id, user_id, master_column_name, extracted_column_name,
      run_id) VALUES (?,?,?,?,?,?)`).run(uuid(), sheetId, uid, status, o, runId)
  }
  db.prepare(`INSERT INTO autorun_columns (id, user_id, sheet_id, status_column, kind, enabled, input_columns,
      daily_row_cap) VALUES (?,?,?,?, 'http', 1, ?, ?)`)
    .run(uuid(), uid, sheetId, status, JSON.stringify(reads), rowCap)
}

async function main() {
  column('Push', ['Email'], ['Lead id'])            // reads what the run writes
  column('Log', ['Lead id'], [], 5)                 // reads what Push writes, room for 5 rows today
  column('Other', ['Phone'])                        // reads nothing the chain writes
  column('Work email', ['Name'])                    // the run's own column
  const chain = await estimateAutorunRows(uid, sheetId, 40, { afterWriting: ['Work email', 'Email'] })
  check('the chain, in order', JSON.stringify(chain?.map(c => c.column)) === '["Push","Log"]')
  check('an HTTP column sends at most its row cap', chain?.[1].rows === 5 && chain?.[0].rows === 40)
  const all = await estimateAutorunRows(uid, sheetId, 40)
  check('new rows set off every auto-run', all?.length === 4)
  const none = await estimateAutorunRows(uid, sheetId, 40, { afterWriting: ['Company'] })
  check('a run writing nothing they read sets nothing off', none?.length === 0)

  if (failures) { console.log(`\n${failures} failed`); process.exit(1) }
  console.log('\nall passed')
}
main().catch(err => { console.error(err); process.exit(1) })
