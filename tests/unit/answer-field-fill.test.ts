// The "+ Column" fill (services/answer-field-fill.ts) against a migrated
// throwaway DB: the new column is linked to every run of the status column,
// each row takes the newest run that answered it (completed or failed; a
// pending result leaves it to an older run), rows no run answered stay empty,
// and a fill resumed from its saved cursor ends the same way.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import fillMod from '../../server/src/services/answer-field-fill'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { runFieldJob } = fillMod as typeof import('../../server/src/services/answer-field-fill')

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
db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
  .run(sheetId, tableId, uid, 'S', JSON.stringify(['Name', 'Email', 'Title']))
for (let i = 0; i < 7; i++) {
  db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    .run(uuid(), sheetId, uid, i, JSON.stringify({ Name: `P${i}` }))
}
const config = JSON.stringify({ responseMapping: [], enrichment: { kind: 'waterfall', email: null } })
let tick = 0
function run(): string {
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, created_at)
    VALUES (?,?,?,?, 'completed', 'Email', datetime('now', ?))`)
    .run(id, sheetId, uid, config, `-${100 - tick++} seconds`)
  return id
}
function answer(runId: string, row: number, title: string, status = 'completed') {
  db.prepare(`INSERT INTO http_results (id, run_id, user_id, row_index, response_data, status)
    VALUES (?,?,?,?,?,?)`).run(uuid(), runId, uid, row,
    JSON.stringify({ output: { title }, _treg: { outcome: 'hit' }, $fill: 'all' }), status)
}
const titles = () => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
  .all(sheetId) as string[]).map(d => JSON.parse(d).Title ?? '')
function job(): string {
  const id = uuid()
  db.prepare(`INSERT INTO enrichment_field_jobs (id, user_id, sheet_id, status_column, column_name, json_path)
    VALUES (?,?,?,?,?,?)`).run(id, uid, sheetId, 'Email', 'Title', '$.output.title')
  return id
}

async function main() {
  const old = run()
  for (let r = 0; r < 6; r++) answer(old, r, `old${r}`)
  const mid = run()
  answer(mid, 2, 'mid2')
  answer(mid, 4, 'mid4', 'pending')
  const fresh = run()
  answer(fresh, 1, 'new1')
  answer(fresh, 3, 'new3')

  const first = job()
  await runFieldJob(first)
  const want = ['old0', 'new1', 'mid2', 'new3', 'old4', 'old5', '']
  check(`each row takes its newest answer (${titles().join(',')})`, JSON.stringify(titles()) === JSON.stringify(want))
  const links = db.prepare(`SELECT COUNT(*) FROM http_column_associations WHERE extracted_column_name = 'Title'`)
    .pluck().get() as number
  check('the column is linked to every run of the status column', links === 3)
  const done = db.prepare('SELECT status, stage FROM enrichment_field_jobs WHERE id = ?').get(first) as
    { status: string; stage: string }
  check('the job is done', done.status === 'done' && done.stage === 'fill')

  // A restart after the newest run was filled: the rest goes on from the cursor.
  db.prepare(`UPDATE rows SET data = json_remove(data, '$.Title') WHERE sheet_id = ?`).run(sheetId)
  db.prepare(`UPDATE rows SET data = json_set(data, '$.Title', ?) WHERE sheet_id = ? AND row_index = ?`)
    .run('new1', sheetId, 1)
  db.prepare(`UPDATE rows SET data = json_set(data, '$.Title', ?) WHERE sheet_id = ? AND row_index = ?`)
    .run('new3', sheetId, 3)
  const resumed = job()
  db.prepare(`UPDATE enrichment_field_jobs SET stage = 'fill', run_pos = 1, row_cursor = -1 WHERE id = ?`)
    .run(resumed)
  await runFieldJob(resumed)
  check(`a resumed fill ends the same (${titles().join(',')})`, JSON.stringify(titles()) === JSON.stringify(want))

  if (failures) { console.log(`\n${failures} failed`); process.exit(1) }
  console.log('\nall passed')
  process.exit(0)
}
main().catch(err => { console.error(err); process.exit(1) })
