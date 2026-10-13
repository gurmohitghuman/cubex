// What a run sets off through auto-run (services/autorun-estimate.ts
// afterWriting), against a migrated throwaway DB: the auto-runs that read a
// column the run writes, then the ones those set off in turn, never the run's
// own column, never one that reads none of them. HTTP API columns only, so no
// treg catalog is asked. Then list auto-runs adding rows to each other's
// sheets: a loop is refused on turn-on and on a run started by hand, and
// paused on every tick (it goes on once the loop is broken). Then what an HTTP
// request reads that isn't there: turning auto-run on and the tick refuse it
// alike, and a stopped run's words are redacted.
// Over 200 lines: one script over one throwaway DB; its three parts share the account and the sheets' fixtures.
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
  await listLoops()
  await missingReads()

  if (failures) { console.log(`\n${failures} failed`); process.exit(1) }
  console.log('\nall passed')
}
// List columns (enrichments adding rows to another sheet) with auto-run, by sheet name.
async function listLoops() {
  const list = await import('../../server/src/services/autorun-list')
  const loop = await import('../../server/src/services/autorun-loop')
  const sheet: Record<string, string> = {}
  for (const name of ['A', 'B', 'C', 'X', 'Y']) {
    sheet[name] = uuid()
    db.prepare('INSERT INTO sheets (id, table_id, user_id, name) VALUES (?,?,?,?)').run(sheet[name], tableId, uid, name)
  }
  const listConfig = (dest: string) => ({
    requestConfig: { method: 'POST', url: 'x', headers: {}, body: '{}' }, responseMapping: [],
    enrichment: { v: 1, list: { destSheetId: dest, fields: [{ path: '$.name', columnName: 'Name' }], copy: [] } },
  })
  // A run of `column` on `from` adding rows to `to` (the column's newest run).
  const listRun = (from: string, column: string, to: string) => db.prepare(`INSERT INTO http_runs (id, sheet_id,
    user_id, config, status, master_column_name, dest_sheet_id) VALUES (?,?,?,?, 'completed', ?, ?)`)
    .run(uuid(), sheet[from], uid, JSON.stringify(listConfig(sheet[to])), column, sheet[to])
  const autoOn = (on: string, column: string) => {
    const id = uuid()
    db.prepare(`INSERT INTO autorun_columns (id, user_id, sheet_id, status_column, kind, enabled, input_columns,
      rescan) VALUES (?,?,?,?, 'enrichment', 1, '[]', 1)`).run(id, uid, sheet[on], column)
    return id
  }
  const pauseOf = (id: string) => db.prepare('SELECT paused_reason AS r, paused_message AS m FROM autorun_columns'
    + ' WHERE id = ?').get(id) as { r: string | null; m: string | null }

  listRun('A', 'People', 'B'); const people = autoOn('A', 'People')
  listRun('B', 'Company', 'C'); const company = autoOn('B', 'Company')
  check('turning on a list auto-run that adds rows elsewhere is fine',
    list.autorunListProblem(sheet.B, uid, listConfig(sheet.C) as never) === null)
  check('turning one on whose rows come back is refused, naming the auto-run that sends them back',
    list.autorunListProblem(sheet.B, uid, listConfig(sheet.A) as never)
    === 'Rows it adds to A would set off auto-run on "People" in A, which adds rows back here. '
    + 'Turn that auto-run off first.')

  const byHand = list.manualListLoop(sheet.B, uid, 'Company', sheet.A)
  check('a run by hand pointing an auto-run column back is refused (409), saying what to turn off',
    byHand?.fail === 'conflict' && byHand.message.includes('Turn off auto-run on "People" in A, or on this column'))
  check('... pointing it elsewhere is fine', list.manualListLoop(sheet.B, uid, 'Company', sheet.C) === null)
  check('a column without auto-run adds rows once, so its run by hand is fine',
    list.manualListLoop(sheet.B, uid, 'Other', sheet.A) === null)
  listRun('X', 'P', 'Y'); autoOn('X', 'P'); listRun('Y', 'Q', 'X'); autoOn('Y', 'Q')
  check('a loop elsewhere (X and Y) ends the walk without blaming this one',
    list.manualListLoop(sheet.A, uid, 'People', sheet.X) === null)

  // A run by hand (MCP, an older build) already pointed Company back at A: every tick looks again.
  listRun('B', 'Company', 'A')
  await loop.autorunTick(company)
  await loop.autorunTick(people)
  check('each auto-run in the loop pauses on its tick, naming the other',
    pauseOf(company).r === 'loop' && pauseOf(people).r === 'loop'
    && pauseOf(company).m === 'Rows it adds to A would set off auto-run on "People" in A, which adds rows back '
      + 'here. Auto-run here goes on once that auto-run is off.'
    && pauseOf(people).m!.includes('auto-run on "Company" in B'))
  db.prepare('UPDATE autorun_columns SET enabled = 0 WHERE id = ?').run(company)
  await loop.autorunTick(people)
  check('turning one off lets the other go on by itself', pauseOf(people).r === null)
}

// An HTTP column whose request reads {{Email}}, after Email is deleted.
async function missingReads() {
  const rules = await import('../../server/src/lib/autorun-rules')
  const settings = await import('../../server/src/services/autorun-settings')
  const loop = await import('../../server/src/services/autorun-loop')
  const cols = await import('../../server/src/lib/autorun-columns')
  const stop = await import('../../server/src/services/autorun-stop')
  const req = (url: string, body = '{}') =>
    ({ requestConfig: { method: 'POST', url, headers: {}, body }, responseMapping: [] }) as never
  const miss = (url: string, columns: string[], before: string[], keys: string[]) =>
    rules.missingRequestRead(req(url), columns, before, new Set(keys))
  check('a column it watched before stays gone, even when a saved key has its name',
    miss('https://x.test/{{Email}}', ['Name'], ['Email'], ['Email']) === 'Email')
  check('a {{name}} matching no column or saved key is missing', miss('https://x.test/{{Email}}', ['Name'], [], [])
    === 'Email' && miss('https://x.test/?k={{my_key}}', ['Name'], [], []) === 'my_key')
  check('a saved key it may use is fine, as is a column in any case or a /path',
    miss('https://x.test/v1/users?k={{my_key}}&e={{email}}', ['Email'], [], ['my_key']) === null)

  const sheet = uuid()
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
    .run(sheet, tableId, uid, 'Leads', JSON.stringify(['Email', 'Name', 'Push', 'Ping']))
  const runOf = (column: string, config: unknown, allow = 1) => db.prepare(`INSERT INTO http_runs (id, sheet_id,
    user_id, config, status, master_column_name, allow_secrets) VALUES (?,?,?,?, 'completed', ?, ?)`)
    .run(uuid(), sheet, uid, JSON.stringify(config), column, allow)
  runOf('Push', req('https://x.test/leads', '{"email":"{{Email}}","name":"{{Name}}"}'))
  const save = (column: string, enabled = true) => settings.saveAutorunSettings(uid, sheet,
    { column, enabled, where: null, dailyCapUsd: null, dailyRowCap: null }, { hasSecretsScope: true })
  const entry = () => db.prepare(`SELECT id, paused_reason AS r, input_columns AS i FROM autorun_columns
    WHERE sheet_id = ? AND status_column = 'Push'`).get(sheet) as { id: string; r: string | null; i: string }
  check('turning it on works while its inputs are there', 'ok' in await save('Push'))
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(['Name', 'Push', 'Ping']), sheet)
  cols.deleteAutorunColumnRefs(sheet, uid, 'Email')
  db.prepare(`INSERT INTO api_keys (id, user_id, name, key_type, key_value_encrypted)
    VALUES (?,?, 'Email', 'custom', 'x')`).run(uuid(), uid)
  await save('Push', false)
  const again = await save('Push')
  check('off and on again after an input was deleted is refused, a saved key of its name or not',
    'fail' in again && again.message === "This column reads Email, which isn't in this sheet anymore. "
      + 'Edit the column first.' && JSON.parse(entry().i).includes('Email'))
  runOf('Ping', req('https://x.test/{{Phone}}'))
  const first = await save('Ping')
  check('a first turn-on whose request reads a name that is nothing here is refused',
    'fail' in first && first.message.startsWith('This column reads Phone,'))

  // An entry an older build saved without the deleted column: the tick finds it by its {{Email}}.
  db.prepare("DELETE FROM api_keys WHERE user_id = ? AND name = 'Email'").run(uid)
  db.prepare(`UPDATE autorun_columns SET enabled = 1, input_columns = '["Name"]', paused_reason = NULL
    WHERE id = ?`).run(entry().id)
  await loop.autorunTick(entry().id)
  check('the tick pauses it as missing_input too', entry().r === 'missing_input')
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?')
    .run(JSON.stringify(['Email', 'Name', 'Push', 'Ping']), sheet)
  await loop.autorunTick(entry().id)
  check('... and goes on once Email is back', entry().r === null)

  // A stopped auto-run run: treg's detail text can carry a key.
  const runId = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, status, master_column_name, autorun_id, worker_generation)
    VALUES (?,?,?, 'running', 'Push', ?, 1)`).run(runId, sheet, uid, entry().id)
  const run = db.prepare('SELECT * FROM http_runs WHERE id = ?').get(runId) as never
  await stop.stopAutorunRun(run, 1, 'unreachable', 'treg said: Bearer abcdefghijklmnop1234', null)
  const saved = db.prepare(`SELECT r.error_message AS e, a.paused_message AS p FROM http_runs r
    JOIN autorun_columns a ON a.id = r.autorun_id WHERE r.id = ?`).get(runId) as { e: string; p: string }
  check('a stopped run keeps its words redacted, in the run and the pause',
    saved.e === 'treg said: [REDACTED]' && saved.p === 'treg said: [REDACTED]')
  // A run with no per-row cap keeps its note on what stopped it.
  const { UNCAPPED_BILLED_NOTE } = await import('../../server/src/lib/enrich-estimate')
  const { pauseEntry } = await import('../../server/src/services/autorun-entry')
  const uncapped = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, status, master_column_name, autorun_id, worker_generation)
    VALUES (?,?,?, 'running', 'Push', ?, 1)`).run(uncapped, sheet, uid, entry().id)
  await stop.stopAutorunRun(db.prepare('SELECT * FROM http_runs WHERE id = ?').get(uncapped) as never, 1,
    'daily_limit', `Today's limit is reached ($1.00 spent today). ${UNCAPPED_BILLED_NOTE}`, null)
  const note = () => db.prepare('SELECT paused_message FROM autorun_columns WHERE id = ?').pluck().get(entry().id)
  check("the daily limit's pause keeps the no-cap note",
    /^Today's \$[\d.]+ enrichment limit is reached\. /.test(String(note()))
    && String(note()).endsWith(UNCAPPED_BILLED_NOTE))
  pauseEntry(entry().id, 'dest_full', 'Leads is full: x-api-key: abc123secret')
  check('every pause keeps its words redacted', note() === 'Leads is full: x-api-key: [REDACTED]')
}

main().catch(err => { console.error(err); process.exit(1) })
