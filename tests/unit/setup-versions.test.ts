// Over 200 lines: one restore story on one sheet, each check building on the one before.
// Setup versions on a migrated throwaway DB (services/setup-version-*.ts): a
// save keeps every column's setup and History says so; names are unique in a
// sheet; a dry restore says what would change and changes nothing; a restore
// keeps the setup it replaces first, adds a deleted formula column back empty
// with its record, gives an AI and an HTTP column their old setup as a run
// record that ran nothing (no usage, not in list_runs), puts descriptions,
// auto-run (a hand pause stays) and the order back, writes no cell; a column
// rename reaches the versions; a run going refuses a restore; a column filled
// another way now is left.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).stack)
  }
}

runMigrations()
const store = await import('../../server/src/services/setup-version-store')
const { restoreSetupVersion } = await import('../../server/src/services/setup-version-restore')
const { renameSheetColumn } = await import('../../server/src/services/column-rename')
const { deleteSheetColumn } = await import('../../server/src/services/column-delete')
const { listRuns } = await import('../../server/src/services/run-list')
const { setSheetAutorunPaused } = await import('../../server/src/services/autorun-settings')
const { setDerivedAutorun } = await import('../../server/src/services/derived-autorun')
const { writeColumnDescription } = await import('../../server/src/lib/column-descriptions')

const uid = uuid(), tid = uuid(), sid = uuid()
const COLS = ['Name', 'Website', 'Domain', 'Clean name', 'Fit (Output)', 'Lookup', 'Post id']
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
  .run(sid, tid, uid, 'Leads', JSON.stringify(COLS))
for (const [i, [n, w]] of [['ada lovelace', 'acme.com'], ['grace', 'navy.mil']].entries()) {
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)').run(uuid(), sid, uid, i,
    JSON.stringify({ Name: n, Website: w, Domain: w.split('.')[0], 'Clean name': n, 'Fit (Output)': 'yes' }))
}
const P1 = 'Is /name at /domain a fit?', P2 = 'Is /name a fit?'
const aiRun = (prompt: string, status = 'completed') => {
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,status,total_rows,processed_rows)
    VALUES (?,?,?,?,?,?,?,2,2)`).run(id, sid, uid, 'Fit (Output)', prompt, 'm1', status)
  return id
}
aiRun(P1)
const URL1 = 'https://example.com/{{Domain}}'
db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name) VALUES (?,?,?,?,?,?)`)
  .run('h1', sid, uid, JSON.stringify({ requestConfig: { method: 'GET', url: URL1, headers: {} },
    responseMapping: [{ jsonPath: '$.id', columnName: 'Post id' }] }), 'completed', 'Lookup')
db.prepare(`INSERT INTO http_column_associations (id,sheet_id,user_id,master_column_name,extracted_column_name,run_id)
  VALUES (?,?,?,?,?,?)`).run(uuid(), sid, uid, 'Lookup', 'Post id', 'h1')
db.prepare(`INSERT INTO formula_columns (id,user_id,sheet_id,column_name,formula,inputs,fill_status)
  VALUES (?,?,?,?,?,?,'done')`).run(uuid(), uid, sid, 'Domain', '{{Website}}.split(".")[0]', '["Website"]')
db.prepare(`INSERT INTO clean_columns (id,user_id,sheet_id,column_name,source_column,cleaner,options,fill_status)
  VALUES (?,?,?,?,?,?,?,'done')`).run(uuid(), uid, sid, 'Clean name', 'Name', 'person_name', '{}')
db.prepare(`INSERT INTO autorun_columns
    (id,user_id,sheet_id,status_column,kind,enabled,input_columns,run_if,daily_row_cap)
  VALUES (?,?,?,'Lookup','http',1,'["Domain"]','{{Domain}} is not empty',100)`).run(uuid(), uid, sid)
setDerivedAutorun('formula', sid, uid, 'Domain', ['Website'], true)
setDerivedAutorun('clean', sid, uid, 'Clean name', ['Name'], true)
writeColumnDescription(sid, uid, 'Name', 'Person')

const order = () => JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck().get(sid) as string)
const cells = () => db.prepare('SELECT row_index, data FROM rows WHERE sheet_id = ? ORDER BY row_index').all(sid)
const history = () => db.prepare('SELECT action, summary FROM sheet_changes WHERE sheet_id = ? ORDER BY id')
  .all(sid) as Array<{ action: string; summary: string }>
const newestAi = () => db.prepare(`SELECT * FROM ai_runs WHERE sheet_id = ? AND column_name = 'Fit (Output)'
  ORDER BY rowid DESC LIMIT 1`).get(sid) as any
const newestHttp = () => db.prepare(`SELECT * FROM http_runs WHERE sheet_id = ? AND master_column_name = 'Lookup'
  ORDER BY rowid DESC LIMIT 1`).get(sid) as any
const entry = (c: string) =>
  db.prepare('SELECT * FROM autorun_columns WHERE sheet_id = ? AND status_column = ?').get(sid, c) as any
let v1 = ''

await check('save keeps every column in order; names are unique in the sheet; History says so', () => {
  const out = store.saveSetupVersion(sid, uid, { name: 'v1', description: 'before the prompt change' })
  assert.ok('ok' in out)
  v1 = out.ok.id
  assert.equal(out.ok.columns, 7)
  assert.equal(out.ok.filled, 4)
  const again = store.saveSetupVersion(sid, uid, { name: 'V1 ' })
  assert.ok('fail' in again && again.fail === 'conflict')
  assert.ok(history().some(h => h.action === 'setup_version_saved' && h.summary.includes('"v1"')))
  assert.deepEqual(store.listSetupVersions(sid, uid)!.map(v => v.name), ['v1'])
})

// The sheet changes: a new prompt ran, the formula column is deleted, a
// description edited, a column added first, a clean column's auto-run off,
// and the HTTP column's auto-run paused by hand.
aiRun(P2)
const del = await deleteSheetColumn(sid, uid, 'Domain')
assert.ok('ok' in del)
writeColumnDescription(sid, uid, 'Name', 'Changed')
db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(['Notes', ...order()]), sid)
setDerivedAutorun('clean', sid, uid, 'Clean name', ['Name'], false)
setSheetAutorunPaused(uid, sid, true, 'Lookup')

await check('a dry restore says what would change, column by column, and changes nothing', async () => {
  const before = JSON.stringify([cells(), order(), newestAi().id])
  const out = await restoreSetupVersion(sid, uid, v1, { dryRun: true, hasSecretsScope: true, reveal: false })
  assert.ok('ok' in out)
  const by = new Map(out.ok.columns.map(c => [c.column, c]))
  assert.equal(by.get('Domain')!.action, 'add_back')
  assert.deepEqual(by.get('Fit (Output)')!.fields.map(f => f.field), ['Prompt'])
  assert.equal(by.get('Lookup')!.action, 'restore')
  assert.deepEqual(by.get('Lookup')!.fields,
    [{ field: 'Reads columns that were deleted', version: null, now: 'Domain' }])
  // Only a deleted read changed: its cells don't need to run again.
  assert.equal(by.get('Lookup')!.note, null)
  assert.match(by.get('Fit (Output)')!.note ?? '', /Force run all rows/)
  assert.equal(out.ok.blocked, null)
  assert.deepEqual(by.get('Name')!.fields, [{ field: 'Description', version: 'Person', now: 'Changed' }])
  assert.deepEqual(by.get('Clean name')!.fields.map(f => f.field), ['Auto-run'])
  assert.equal(by.get('Notes')!.action, 'keep')
  assert.equal(out.ok.dry_run, true)
  assert.equal(JSON.stringify([cells(), order(), newestAi().id]), before)
  assert.equal(store.listSetupVersions(sid, uid)!.length, 1)
})

await check('a run going on the sheet refuses a restore', async () => {
  const running = aiRun(P2, 'running')
  const out = await restoreSetupVersion(sid, uid, v1, { dryRun: false, hasSecretsScope: true, reveal: false })
  assert.ok('fail' in out && out.fail === 'conflict', JSON.stringify(out))
  db.prepare('DELETE FROM ai_runs WHERE id = ?').run(running)
})

await check('a restore puts the setup back, keeps the one it replaced, and writes no cell', async () => {
  const rows = JSON.stringify(cells())
  const out = await restoreSetupVersion(sid, uid, v1, { dryRun: false, hasSecretsScope: true, reveal: false })
  assert.ok('ok' in out, JSON.stringify(out))
  assert.equal(out.ok.saved_before?.name, 'Before restoring: v1')
  assert.equal(out.ok.saved_before?.auto, true)
  assert.deepEqual(order(), ['Notes', 'Name', 'Website', 'Domain', 'Clean name', 'Fit (Output)', 'Lookup', 'Post id'])
  assert.equal(JSON.stringify(cells()), rows)
  const formula = db.prepare('SELECT * FROM formula_columns WHERE sheet_id = ? AND column_name = ?')
    .get(sid, 'Domain') as any
  assert.equal(formula.fill_status, 'done')
  assert.deepEqual(JSON.parse(formula.inputs), ['Website'])
  assert.equal(entry('Domain').enabled, 1)
  const ai = newestAi()
  assert.equal(ai.setup_only, 1)
  assert.equal(ai.prompt, P1)
  assert.equal(ai.status, 'completed')
  assert.equal(db.prepare('SELECT COUNT(*) FROM run_usage WHERE run_id = ?').pluck().get(ai.id), 0)
  assert.ok(!listRuns(uid, { sheetId: sid }).some(r => r.id === ai.id))
  const http = newestHttp()
  assert.equal(http.setup_only, 1)
  assert.equal(JSON.parse(http.config).requestConfig.url, URL1)
  assert.equal(entry('Lookup').enabled, 1)
  assert.equal(entry('Lookup').run_if, '{{Domain}} is not empty')
  assert.equal(entry('Lookup').paused_reason, 'user')
  assert.equal(entry('Clean name').enabled, 1)
  assert.equal(db.prepare('SELECT description FROM column_descriptions WHERE sheet_id = ? AND column_name = ?')
    .pluck().get(sid, 'Name'), 'Person')
  assert.ok(history().some(h => h.action === 'setup_version_restored' && h.summary.includes('"v1"')))
  const again = await restoreSetupVersion(sid, uid, v1, { dryRun: false, hasSecretsScope: true, reveal: false })
  assert.ok('ok' in again && again.ok.nothing && again.ok.saved_before === null)
})

await check('restoring the kept copy goes back to the setup before the restore', async () => {
  const kept = store.listSetupVersions(sid, uid)!.find(v => v.auto)!
  const out = await restoreSetupVersion(sid, uid, kept.id, { dryRun: false, hasSecretsScope: true, reveal: false })
  assert.ok('ok' in out, JSON.stringify(out))
  assert.equal(newestAi().prompt, P2)
  assert.equal(store.listSetupVersions(sid, uid)!.filter(v => v.auto).length, 2)
})

await check('a column rename reaches the versions', async () => {
  const out = await renameSheetColumn(sid, uid, 'Website', 'Site')
  assert.ok('ok' in out, JSON.stringify(out))
  const spec = store.readSetupVersion(sid, uid, v1)
  assert.ok(!('fail' in spec))
  const domain = spec.spec.columns.find(c => c.name === 'Domain')!
  assert.equal((domain.fill as any).formula, '{{Site}}.split(".")[0]')
  assert.ok(spec.spec.columns.some(c => c.name === 'Site') && !spec.spec.columns.some(c => c.name === 'Website'))
  const dry = await restoreSetupVersion(sid, uid, v1, { dryRun: true, hasSecretsScope: true, reveal: false })
  assert.ok('ok' in dry && !dry.ok.columns.some(c => c.column === 'Domain' || c.column === 'Site'))
})

await check('a column filled another way now is left, and says why', async () => {
  assert.ok('ok' in await deleteSheetColumn(sid, uid, 'Clean name'))
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify([...order(), 'Clean name']), sid)
  const out = await restoreSetupVersion(sid, uid, v1, { dryRun: true, hasSecretsScope: true, reveal: false })
  assert.ok('ok' in out)
  const c = out.ok.columns.find(x => x.column === 'Clean name')!
  assert.equal(c.action, 'leave')
  assert.match(c.note ?? '', /it was a clean data column\. It's a plain column now/)
})

await check('rename and delete a version', () => {
  const out = store.updateSetupVersion(sid, uid, v1, { name: 'Launch setup' })
  assert.ok('ok' in out && out.ok.name === 'Launch setup')
  assert.ok('ok' in store.deleteSetupVersion(sid, uid, v1))
  assert.ok('fail' in store.deleteSetupVersion(sid, uid, v1))
})

if (failures) { console.error(`${failures} failed`); process.exit(1) }
console.log('setup-versions: all passed')
