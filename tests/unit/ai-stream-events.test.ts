// What the AI SSE stream sends per result row (server/src/lib/ai-stream-events.ts).
// A STRUCTURED run's typed cells used to reach open grids only through sheet
// reloads (each row bumped data_version), which snapped deep-scrolled viewports
// back every ~15 s. Now its result event carries the row's saved cells, and the
// row writes leave data_version alone. Real writers against a throwaway DB.
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import evMod from '../../server/src/lib/ai-stream-events'
import wMod from '../../server/src/services/ai-row-writers-multi'
import { v4 as uuid } from 'uuid'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
runMigrations()
const { resultEvents, structuredRunColumns } = evMod as typeof import('../../server/src/lib/ai-stream-events')
const { writeMultiSuccess, writeMultiFailure } =
  wMod as typeof import('../../server/src/services/ai-row-writers-multi')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

const STATUS = 'Lead (Status)'
const DATA = 'Lead (Data)'
const specs = [
  { columnName: 'Score', type: 'number' as const, description: '1-10' },
  { columnName: 'Reason', type: 'string' as const, description: 'why' },
]
const uid = uuid(), tid = uuid(), sid = uuid(), rid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
  .run(sid, tid, uid, 'S', JSON.stringify(['val', 'Score', 'Reason', STATUS, DATA]))
for (const i of [0, 1]) {
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)').run(uuid(), sid, uid, i,
    JSON.stringify({ val: `v${i}`, Score: '⏳ Processing...', Reason: '⏳ Processing...', [STATUS]: '⏳ Processing...',
      [DATA]: '⏳ Processing...' }))
}
db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,status,worker_generation,total_rows,
  processed_rows,output_columns,status_column,data_column) VALUES (?,?,?,?,?,?, 'running', 0, 2, 0, ?, ?, ?)`)
  .run(rid, sid, uid, STATUS, 'Score /val', 'm', JSON.stringify(specs), STATUS, DATA)

const run = db.prepare(`SELECT column_name, use_openrouter_web_search, output_columns, sheet_id, status_column,
  data_column FROM ai_runs WHERE id = ?`).get(rid) as import('../../server/src/lib/ai-stream-events').StreamRun
const columns = structuredRunColumns(run)!
check('structured columns: status first, outputs, then (Data)',
  JSON.stringify(columns) === JSON.stringify([STATUS, 'Score', 'Reason', DATA]))

const version = () => (db.prepare('SELECT data_version AS v FROM sheets WHERE id = ?').get(sid) as { v: number }).v
const before = version()
const ctx = (rowIndex: number) => ({
  runId: rid, userId: uid, sheetId: sid, rowIndex, inputValues: '{}', statusColumn: STATUS, myGeneration: 0,
})
writeMultiSuccess(ctx(0), { Score: '9', Reason: 'Big "payments" API' }, '{"Score":9}', undefined,
  { column: DATA, summary: '📊 Searched 2 sources', json: null })
writeMultiFailure(ctx(1), ['Score', 'Reason', DATA], 'Model did not return valid JSON')
check('structured row writes no longer bump data_version (no reload storm)', version() === before)

const results = db.prepare(`SELECT id, row_index, output_value, status, error_message, scraped_data, cost_usd,
  web_search_queries FROM ai_results WHERE run_id = ? ORDER BY rowid`).all(rid) as
  Array<import('../../server/src/lib/ai-stream-events').StreamResult>
const ok = resultEvents(uid, run, results[0], columns) as Array<{ cells: Record<string, string>; rowIndex: number }>
check('one event per structured row', ok.length === 1 && ok[0].rowIndex === 0)
check('it carries every saved cell verbatim', JSON.stringify(ok[0].cells) === JSON.stringify({
  [STATUS]: '✅', Score: '9', Reason: 'Big "payments" API', [DATA]: '📊 Searched 2 sources',
}))
const bad = resultEvents(uid, run, results[1], columns) as Array<{ cells: Record<string, string> }>
check('a failed row clears every spinner: ❌ status, blank outputs',
  bad[0].cells[STATUS] === '❌ Error: Model did not return valid JSON'
  && bad[0].cells.Score === '' && bad[0].cells.Reason === '' && bad[0].cells[DATA] === '')

// Single-column runs keep their per-cell events.
const single = { ...run, output_columns: null, column_name: 'Lead (Output)', use_openrouter_web_search: 1 }
const events = resultEvents(uid, single, { ...results[0], output_value: 'hello' }, structuredRunColumns(single)) as
  Array<{ columnName: string; outputValue: string }>
check('single-column: output cell + (Data) cell events', events.length === 2
  && events[0].columnName === 'Lead (Output)' && events[0].outputValue === 'hello'
  && events[1].columnName === 'Lead (Data)')

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nok   ai stream events')
