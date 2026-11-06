// Writes that reach a sheet without going through its sheet-addressed checks
// refuse one in the trash, deleted alone or with its table: a one-row update
// by row id (PATCH /api/v1/rows/:rowId, MCP update_cells), a structured AI
// run's rerun by run id, a run start whose sheet went to the trash while it
// waited (asRunStart, whose check is the account's), auto-run's start when the
// sheet went while the tick picked its rows, and a waterfall dry run when it
// went while the steps were built. Each writes again once the sheet is restored.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
// Nothing listens here: the model list can't be read, so a run's model isn't checked (lib/ai-model-check.ts).
process.env.OPENROUTER_BASE_URL = 'http://127.0.0.1:9/api/v1'

const { trashKit } = await import('./trash-kit')
const { patchRowById } = await import('../../server/src/services/rows-write')
const { txnFailMessage } = await import('../../server/src/services/data-plane-shared')
const { trashSheet, trashTable } = await import('../../server/src/services/trash-sheets')
const { restoreSheetItem } = await import('../../server/src/services/trash-restore-sheet')
const { rerunAiRunById } = await import('../../server/src/services/run-rerun-by-id')
const { asRunStart } = await import('../../server/src/services/run-seed')
const { autorunTick } = await import('../../server/src/services/autorun-loop')
const { sheetBusyWith } = await import('../../server/src/lib/sheet-busy')
const { startWaterfallDryRun } = await import('../../server/src/services/waterfall-dry-run')
const { parseWaterfallInput } = await import('../../server/src/lib/waterfall/input')
const { db, uid, ok, done, fixture, rowsOf, idle } = trashKit('trash-row-writes')
console.error = () => {}

type Place = { table: string; sid: string }
// A sheet in a table of its own, with a spare sheet beside it so it can go alone.
const place = (columns = ['Email', 'Name']): Place => {
  const table = uuid()
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(table, uid, `T_${table.slice(0, 8)}`)
  const sid = fixture(3, columns, table)
  fixture(1, ['Email', 'Name'], table)
  return { table, sid }
}
const HOWS = [['sheet', 'deleted alone'], ['table', 'deleted with its table']] as const
// Into the trash, alone or with its table: the trash item that brings it back.
const trash = (how: 'sheet' | 'table', p: Place): number => {
  const out = how === 'sheet' ? trashSheet(uid, p.table, p.sid) : trashTable(uid, p.table)
  assert.ok('ok' in out && out.ok.trashId, JSON.stringify(out))
  return out.ok.trashId!
}
const restore = (id: number) => { const r = restoreSheetItem(uid, id); assert.ok('ok' in r, JSON.stringify(r)) }
const version = (sid: string) => db.prepare('SELECT data_version FROM sheets WHERE id = ?').pluck().get(sid)
const count = (sql: string, ...p: unknown[]) => db.prepare(sql).pluck().get(...p) as number

for (const [how, words] of HOWS) {
  await ok(`a one-row update by row id refuses a sheet ${words}, as the sheet's own forms do`, () => {
    const p = place()
    const row = rowsOf(p.sid)[0]
    const id = trash(how, p)
    const v = version(p.sid)
    const out = patchRowById(row.id, uid, { Name: 'changed' })
    assert.deepEqual(out, { fail: 'sheet_not_found' })
    assert.equal(txnFailMessage(out as { fail: 'sheet_not_found' }, 0), 'Sheet not found')
    assert.equal(rowsOf(p.sid)[0].data, row.data, 'the row is as it was')
    assert.equal(version(p.sid), v, 'nothing tells open tabs to reload')
    restore(id)
    const back = patchRowById(row.id, uid, { Name: 'changed' })
    assert.ok('ok' in back && back.ok.data.Name === 'changed', JSON.stringify(back))
  })

  await ok(`a structured AI run's rerun by run id refuses a sheet ${words}`, async () => {
    const p = place(['Email', 'Name', 'Score', 'Lead (Status)'])
    const run = uuid()
    db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,status,output_columns,status_column)
      VALUES (?,?,?,'Lead (Status)','Rate /email','test/model','completed',?,'Lead (Status)')`)
      .run(run, p.sid, uid, JSON.stringify([{ columnName: 'Score', type: 'number', description: 'A score' }]))
    const before = rowsOf(p.sid)
    const runs = () => count('SELECT COUNT(*) FROM ai_runs WHERE sheet_id = ?', p.sid)
    const had = runs()
    trash(how, p)
    const out = await rerunAiRunById(uid, run, { mode: 'all' })
    assert.deepEqual(out, { fail: 'not_found', message: 'Sheet not found' })
    await idle(p.sid)
    assert.equal(runs(), had, 'no run')
    assert.deepEqual(rowsOf(p.sid), before, 'no cell was touched')
  })

  await ok(`a run start that waited takes no run on a sheet ${words} meanwhile`, async () => {
    const p = place()
    const id = trash(how, p)
    let ran = false
    const out = await asRunStart(p.sid, uid, async () => { ran = true; return { started: true } })
    assert.deepEqual(out, { fail: 'not_found', message: 'Sheet not found' })
    assert.equal(ran, false, 'the start never ran')
    assert.equal(sheetBusyWith(p.sid), null, 'the sheet is free again')
    restore(id)
    assert.deepEqual(await asRunStart(p.sid, uid, async () => ({ started: true })), { started: true })
  })

  await ok(`auto-run starts no run on a sheet ${words} while its tick picked the rows`, async () => {
    const p = place(['Email', 'Name', 'Push'])
    const config = { requestConfig: { method: 'POST', url: 'https://x.test/leads', headers: {},
      body: '{"email":"{{Email}}"}' }, responseMapping: [] }
    db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
      VALUES (?,?,?,?,'completed','Push')`).run(uuid(), p.sid, uid, JSON.stringify(config))
    const entry = uuid()
    db.prepare(`INSERT INTO autorun_columns (id,user_id,sheet_id,status_column,kind,input_columns)
      VALUES (?,?,?,'Push','http','["Email"]')`).run(entry, uid, p.sid)
    const before = rowsOf(p.sid)
    const tick = autorunTick(entry)       // runs up to its first wait (picking the rows)...
    trash(how, p)                         // ...and the sheet goes to the trash then
    await tick
    await idle(p.sid)
    assert.equal(count('SELECT COUNT(*) FROM http_runs WHERE autorun_id = ?', entry), 0, 'no run started')
    assert.deepEqual(rowsOf(p.sid), before, 'no ⏳ was written')
  })

  await ok(`a waterfall dry run starts no run on a sheet ${words} while its steps were built`, async () => {
    const p = place()
    const input = parseWaterfallInput({
      columnName: 'Work email', resultType: 'email', dry: true,
      inputs: [{ key: 'domain', label: 'Domain', source: { column: 'Email' } }],
      steps: [{ id: 'sownapi', label: 'Own API', choices: {
        kind: 'http', method: 'GET', url: 'https://x.test/find?d={{domain}}', valuePath: '$.email' } }],
    })
    assert.ok('ok' in input, JSON.stringify(input))
    const runs = () => count('SELECT COUNT(*) FROM http_runs WHERE sheet_id = ?', p.sid)
    const dry = startWaterfallDryRun(uid, p.sid, input.ok, { hasSecretsScope: true })
    trash(how, p)                         // while it builds its steps
    const out = await dry.catch((e: Error) => ({ threw: e.message }))
    assert.deepEqual(out, { fail: 'not_found', message: 'Sheet not found' })
    assert.equal(runs(), 0, 'no run was made')
  })
}

await ok("a run start's check once it holds the sheet is the account's: another id takes no run", async () => {
  const p = place()
  let ran = false
  const out = await asRunStart(p.sid, uuid(), async () => { ran = true; return { started: true } })
  assert.deepEqual(out, { fail: 'not_found', message: 'Sheet not found' })
  assert.equal(ran, false, 'the start never ran')
  assert.equal(sheetBusyWith(p.sid), null, 'the sheet is free again')
})

await ok('a row nobody has, and a row of a live sheet, answer as before', () => {
  assert.deepEqual(patchRowById(uuid(), uid, { Name: 'x' }), { fail: 'not_found' })
  const p = place()
  const out = patchRowById(rowsOf(p.sid)[1].id, uid, { Name: 'live' })
  assert.ok('ok' in out && out.ok.index === 2 && out.ok.data.Name === 'live', JSON.stringify(out))
})

done()
