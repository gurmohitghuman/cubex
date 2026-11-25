// Over 200 lines: one sheet walked through a column run's checks, estimate and start, each step building on the last.
// Running chosen columns on chosen rows (services/column-run*.ts) on a migrated throwaway DB, with
// OpenRouter's model list served by a stand-in. The sheet: an AI column "Fit (Output)", a formula "Len"
// reading it, and an HTTP API column "Ping" whose request reads Len.
//   - the body: mode is required; row_ids and where not both; MCP estimates by default; the app's inFilter
//     alone, and it keeps the estimate to the filter the sheet shows;
//   - a formula column or an unknown name is refused, saying why; Ping waits for Fit, through Len;
//   - a where reading a column the run changes (Len) is refused; one on Name is fine; one choosing more
//     than 50,000 rows only with an enrichment or waterfall column;
//   - row_ids that aren't rows, and a token without 'secrets' on a column reading a saved key, are refused;
//   - the estimate: Fit priced on its empty rows; Ping, after Fit in an out-of-date mode, priced at most;
//   - max_cost_usd under the estimate refuses and creates nothing;
//   - a start whose columns have nothing to do ends done, one History line, the view a setup run with no
//     setup; a live column run on Ping refuses another one there, and a setup that makes Ping;
//   - the hold: a step not started holds its column's auto-run; once it ran or the run ended, it lets go;
//   - two starts at once on one column: one starts, the other is refused (not a second run after the first);
//   - a paused run on a chosen column stops the column run with words;
//   - a where finding a few rows among many is read a slice at a time (other requests run meanwhile).
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const server = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    const pricing = { prompt: '0.00001', completion: '0.00003' }
    res.end(JSON.stringify({ data: [{ id: 'test/priced', name: 'p', pricing }] }))
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { columnRunInputOf } = await import('../../server/src/services/column-run-input')
const { planColumnRun } = await import('../../server/src/services/column-run-plan')
const { runColumns } = await import('../../server/src/services/column-run')
const { columnRunHolds } = await import('../../server/src/services/column-run-hold')
const { selectedRowsProblem, wherePlaces } = await import('../../server/src/services/column-run-rows')
const { startColumnStep } = await import('../../server/src/services/column-run-step')
const { getSetupRun, insertSetupRun, loadSetupRun } = await import('../../server/src/services/setup-run-store')
const { liveSetupClash } = await import('../../server/src/services/setup-apply-checks')
type Input = import('../../server/src/services/column-run-input').ColumnRunInput
runMigrations()
console.warn = () => {}

const ok = (label: string) => console.log('ok  ', label)
const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
  .run(sid, tid, uid, 'People', JSON.stringify(['Name', 'Fit (Output)', 'Len', 'Ping']))
const fit = ['good', 'good', 'good', '❌ Error: upstream', '', '']
const ids = fit.map((f, i) => {
  const id = uuid()
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)').run(id, sid, uid, i,
    JSON.stringify({ Name: `Person ${i}`, 'Fit (Output)': f, Len: String(f.length), Ping: i < 4 ? '200' : '' }))
  return id
})
db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,status,total_rows)
  VALUES (?,?,?,'Fit (Output)','Describe /name','test/priced','completed',6)`).run(uuid(), sid, uid)
db.prepare(`INSERT INTO formula_columns (id,user_id,sheet_id,column_name,formula,inputs,fill_status)
  VALUES (?,?,?,'Len','String({{Fit (Output)}}.length)','["Fit (Output)"]','done')`).run(uuid(), uid, sid)
const pingConfig = (headers: Record<string, string>) => JSON.stringify({
  requestConfig: { url: 'https://example.com/ping?q={{Len}}', method: 'GET', headers }, responseMapping: [],
  previewSize: 5,
})
const pingRun = uuid()
db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,total_rows)
  VALUES (?,?,?,?,'completed','Ping',6)`).run(pingRun, sid, uid, pingConfig({}))
const count = (sql: string) => db.prepare(sql).pluck().get() as number

const input = (b: Record<string, unknown>, from: 'v1' | 'mcp' = 'v1'): Input => {
  const i = columnRunInputOf(b, from)
  if ('fail' in i) throw new Error(i.message)
  return i
}
const bad = (b: Record<string, unknown>) => {
  const i = columnRunInputOf(b, 'v1')
  return 'fail' in i ? i.message : ''
}

// --- The body ------------------------------------------------------------------------------
assert.match(bad({ columns: ['Ping'] }), /^mode is required: empty, errored, out_of_date/)
assert.match(bad({ columns: [], mode: 'all' }), /columns must list 1 to 20/)
assert.match(bad({ columns: ['Ping'], mode: 'all', row_ids: [ids[0]], where: [{ column: 'Name' }] }),
  /row_ids or where, not both/)
assert.match(bad({ columns: ['Ping'], mode: 'all', firstRows: 3 }), /Unknown field firstRows/)
assert.equal(input({ columns: ['Ping'], mode: 'all' }, 'mcp').estimateOnly, true)
assert.equal(input({ columns: ['Ping'], mode: 'all' }).estimateOnly, false)
const app = (b: Record<string, unknown>) => columnRunInputOf(b, 'app')
assert.equal((app({ columns: ['Ping'], mode: 'all', inFilter: true }) as Input).inFilter, true)
assert.match((app({ columns: ['Ping'], mode: 'all', inFilter: true, rowIds: [ids[0]] }) as { message: string })
  .message, /inFilter alone/)
assert.match(bad({ columns: ['Ping'], mode: 'all', inFilter: true }), /Unknown field inFilter/)
ok('the body: mode required, row_ids or where, unknown fields refused; MCP estimates unless told not to')
ok("the app's inFilter is read alone, and only from the app")

// --- What it would do -----------------------------------------------------------------------
const plan = (b: Partial<Input>, secrets = true) =>
  planColumnRun(uid, sid, { columns: [], rowIds: null, where: null, ...b }, { hasSecretsScope: secrets })
const len = plan({ columns: ['Len'] })
assert.ok('fail' in len && len.fail === 'bad_request')
assert.match(len.message, /"Len" is a formula column: it follows its columns for free/)
const nope = plan({ columns: ['Nope'] })
assert.ok('fail' in nope && nope.fail === 'not_found')
const name = plan({ columns: ['Name'] })
assert.ok('fail' in name && /"Name" isn't filled by a run/.test(name.message))
const both = plan({ columns: ['Ping', 'Fit (Output)'] })
assert.ok('ok' in both)
assert.deepEqual(both.ok.columns.map(c => [c.column, c.kind, c.layer, c.between]),
  [['Fit (Output)', 'ai', 0, []], ['Ping', 'http', 1, ['Len']]])
assert.deepEqual(both.ok.columns.map(c => c.waitsFor), [[], [0]])
ok('a formula, an unknown name and a plain column are refused, saying why; Ping waits for Fit through Len')

const onLen = plan({ columns: ['Ping', 'Fit (Output)'], where: [{ column: 'Len', operator: 'eq', value: '4' }] })
assert.ok('fail' in onLen && /The where reads "Len", which this run changes/.test(onLen.message))
assert.ok('ok' in plan({ columns: ['Ping'], where: [{ column: 'Name', operator: 'contains', value: 'Person' }] }))
assert.equal(selectedRowsProblem(['ai', 'http'], 900_000), null)
assert.equal(selectedRowsProblem(['enrichment'], 50_000), null)
assert.match(selectedRowsProblem(['ai', 'waterfall'], 50_001) ?? '',
  /^The where matches 50,001 rows, and an enrichment or waterfall column runs on at most 50,000 chosen rows/)
ok('a where reading a column the run changes is refused; one on a column it leaves alone is fine')
ok('a where choosing more than 50,000 rows is refused only when an enrichment or waterfall column is chosen')

const gone = plan({ columns: ['Ping'], rowIds: [ids[0], 'not-a-row'] })
assert.ok('fail' in gone && gone.fail === 'not_found')
assert.match(gone.message, /1 of the row_ids aren't rows of this sheet/)
db.prepare(`INSERT INTO api_keys (id,user_id,name,key_type,key_value_encrypted) VALUES (?,?,'partner','bearer','x')`)
  .run(uuid(), uid)
const setPing = (headers: Record<string, string>) =>
  db.prepare('UPDATE http_runs SET config = ? WHERE id = ?').run(pingConfig(headers), pingRun)
setPing({ Authorization: 'Bearer {{partner}}' })
const noSecrets = plan({ columns: ['Ping'] }, false)
assert.ok('fail' in noSecrets && noSecrets.fail === 'forbidden')
assert.match(noSecrets.message, /"Ping" reads saved keys \(partner\)\. The access token needs the 'secrets' scope/)
assert.ok('ok' in plan({ columns: ['Ping'] }, true))
setPing({})
ok("row_ids that aren't rows, and a column reading a saved key without 'secrets', are refused")

// --- The estimate ---------------------------------------------------------------------------
const est = await runColumns(uid, sid, input({ columns: ['Fit (Output)', 'Ping'], mode: 'empty_or_out_of_date',
  estimate_only: true }), { hasSecretsScope: true })
assert.ok('ok' in est && 'estimate' in est.ok)
const e = est.ok.estimate
const [efit, eping] = e.columns
assert.equal(e.rows_in_scope, 6)
assert.equal(efit.rows, 2)
assert.ok(efit.high_usd !== null && efit.high_usd > 0 && (efit.row_most_usd ?? 0) > 0, JSON.stringify(efit))
assert.equal(eping.sends_requests, true)
assert.equal(eping.high_usd, null)
assert.equal(eping.rows, 4)
assert.equal(eping.at_most, true)
assert.match(eping.note ?? '', /At most: the columns before it may change what it reads on up to 2 rows/)
assert.equal(e.high_usd, efit.high_usd)
assert.deepEqual(e.unpriced, [])
assert.equal(e.over_ceiling, undefined) // no max_cost_usd: no ceiling fields
ok('the estimate: Fit on its 2 empty rows, priced; Ping after it in an out-of-date mode, its 2 rows plus Fit\'s 2')

// The app's "only rows in the current filter": the filter the sheet shows, read on the server.
db.prepare('UPDATE sheets SET column_filters = ? WHERE id = ?')
  .run(JSON.stringify({ Name: { type: 'contains', value: 'Person 1' } }), sid)
const shown = await runColumns(uid, sid, columnRunInputOf({ columns: ['Fit (Output)'], mode: 'all', inFilter: true,
  estimateOnly: true }, 'app') as Input, { hasSecretsScope: true })
assert.ok('ok' in shown && 'estimate' in shown.ok)
assert.equal(shown.ok.estimate.rows_in_scope, 1)
db.prepare('UPDATE sheets SET column_filters = NULL WHERE id = ?').run(sid)
ok('inFilter keeps the estimate to the rows of the filter the sheet shows')

const over = await runColumns(uid, sid, input({ columns: ['Fit (Output)'], mode: 'all', max_cost_usd: 0.000001 }),
  { hasSecretsScope: true })
assert.ok('fail' in over && over.fail === 'over_ceiling' && over.estimate?.over_ceiling === true)
assert.equal(count('SELECT COUNT(*) FROM setup_runs'), 0)
assert.equal(count('SELECT COUNT(*) FROM ai_runs'), 1)
ok('max_cost_usd under the estimate refuses the start and creates nothing')

// --- A start with nothing to do ---------------------------------------------------------------
const started = await runColumns(uid, sid, input({ columns: ['Ping', 'Fit (Output)'], mode: 'errored',
  row_ids: [ids[0], ids[1]] }), { hasSecretsScope: true })
assert.ok('ok' in started && 'setup_run' in started.ok, JSON.stringify(started))
const view = getSetupRun(uid, started.ok.setup_run.id)!
assert.equal(view.status, 'done', JSON.stringify(view))
assert.equal(view.setup_id, null)
assert.equal(view.setup_name, 'Run columns: Fit (Output), Ping')
assert.deepEqual(view.column_run, { mode: 'errored', row_ids: 2, where: null })
assert.equal(view.test_rows, null)
assert.deepEqual(view.steps.map(s => [s.column, s.kind, s.layer, s.state, s.note]),
  [['Fit (Output)', 'ai', 1, 'done', 'No row needed it.'], ['Ping', 'http', 2, 'done', 'No row needed it.']])
assert.equal(count('SELECT COUNT(*) FROM ai_runs'), 1)
const line = db.prepare(`SELECT action, summary FROM sheet_changes WHERE sheet_id = ?`).get(sid) as
  { action: string; summary: string }
assert.deepEqual(line, { action: 'run_started',
  summary: 'Ran 2 columns (Fit (Output), Ping) on their failed rows among 2 chosen rows' })
ok('a start with nothing to do ends done: a setup run with no setup, its column_run, one History line')

// --- A live column run: clashes and the auto-run hold ----------------------------------------
const liveId = insertSetupRun({
  userId: uid, sheetId: sid, setupId: null, setupName: 'Run columns: Ping',
  plan: { spec: { v: 1, inputs: [], keys: [], steps: [] }, layers: [0],
    columns: { steps: [{ column: 'Ping', kind: 'http', writes: ['Ping'], between: [] }], mode: 'all', where: null } },
  targetRowIds: null, allowSecrets: true, autoRun: false,
})
const again = plan({ columns: ['Ping'] })
assert.ok('fail' in again && again.fail === 'conflict' && /fills "Ping"/.test(again.message))
assert.match(liveSetupClash(uid, sid, ['Ping'])?.message ?? '', /A setup or column run working on this sheet fills/)
assert.equal(columnRunHolds(sid, uid, 'Ping'), true)
assert.equal(columnRunHolds(sid, uid, 'Fit (Output)'), false)
db.prepare(`UPDATE setup_runs SET steps = '[{"state":"running","kind":"http","runId":"x"}]' WHERE id = ?`).run(liveId)
assert.equal(columnRunHolds(sid, uid, 'Ping'), false)
db.prepare(`UPDATE setup_runs SET steps = '[{"state":"waiting"}]', status = 'paused' WHERE id = ?`).run(liveId)
assert.equal(columnRunHolds(sid, uid, 'Ping'), true)
db.prepare(`UPDATE setup_runs SET status = 'cancelled' WHERE id = ?`).run(liveId)
assert.equal(columnRunHolds(sid, uid, 'Ping'), false)
assert.ok('ok' in plan({ columns: ['Ping'] }))
ok('a live column run refuses another on its column and a setup making it; its waiting step holds auto-run')

// --- Two starts at once: each reads its where (a wait) between its checks and its record --------------------
const busyPing = uuid()
db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,total_rows)
  VALUES (?,?,?,?,'running','Ping',6)`).run(busyPing, sid, uid, pingConfig({}))
const byName = [{ column: 'Name', operator: 'contains', value: 'Person' }]
const twice = await Promise.all([1, 2].map(() =>
  runColumns(uid, sid, input({ columns: ['Ping'], mode: 'all', where: byName }), { hasSecretsScope: true })))
assert.deepEqual(twice.map(o => ('fail' in o ? o.fail : 'started')).sort(), ['conflict', 'started'],
  JSON.stringify(twice))
assert.equal(count(`SELECT COUNT(*) FROM setup_runs WHERE status IN ('running', 'paused')`), 1)
db.prepare(`UPDATE setup_runs SET status = 'cancelled' WHERE status IN ('running', 'paused')`).run()
db.prepare(`UPDATE http_runs SET status = 'completed' WHERE id = ?`).run(busyPing)
ok('two starts at once on one column: one starts, the other is refused, never a second paid run after it')

// --- A paused run on a chosen column ----------------------------------------------------------
db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,status,total_rows)
  VALUES (?,?,?,'Fit (Output)','Describe /name','test/priced','paused',6)`).run(uuid(), sid, uid)
const r = loadSetupRun(started.ok.setup_run.id)!
const paused = await startColumnStep(r, { column: 'Fit (Output)', kind: 'ai', writes: [], between: [] },
  { steps: [], mode: 'all', where: null }, { allowSecrets: true, limitUsd: null })
assert.ok('fail' in paused && paused.fail === 'conflict')
assert.match(paused.message, /A run on "Fit \(Output\)" is paused\. Resume or stop it, then run the columns again\./)
ok('a paused run on a chosen column stops its step with words')

// --- A where finding a few rows among many: read a slice of the sheet at a time ------------------------------
const big = uuid()
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
  .run(big, tid, uid, 'Big', JSON.stringify(['Name']))
const add = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
db.transaction(() => { for (let i = 0; i < 20_000; i++) add.run(uuid(), big, uid, i, `{"Name":"P${i}"}`) }).immediate()
let between = false
setImmediate(() => { between = true })
assert.deepEqual(await wherePlaces(big, uid, [{ column: 'Name', operator: 'eq', value: 'P19999' }]), [19999])
assert.equal(between, true, 'other requests ran while the where was read')
ok('a where finding one row among 20,000 reads the sheet a slice at a time, letting other requests in')

server.close()
console.log('All column-run assertions passed.')
process.exitCode = 0
