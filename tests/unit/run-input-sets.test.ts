// Out of date follows what each result was made from (lib/run-inputs/sets.ts, migration 066): a stamp names the
// list of columns its run read, and a row is checked against that list, whatever the column's setup reads later.
// Covers a setup reading one more column, the same columns in another order, an HTTP API column, renames, stamps
// written before 066 (and the migration's own pick of their run), the newest-16 limit and a deleted column's lists.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import fpMod from '../../server/src/lib/run-inputs/fingerprint'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { runInputFingerprint } = fpMod as typeof import('../../server/src/lib/run-inputs/fingerprint')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log('ok  ', label)
  } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

runMigrations()
const { aiRunStamper, requestRunStamper } = await import('../../server/src/lib/run-inputs/stampers')
const { writeRunCells } = await import('../../server/src/lib/run-cells-write')
const { columnStaleCheck } = await import('../../server/src/services/run-inputs')
const { renameSheetColumn } = await import('../../server/src/services/column-rename')
const { deleteRunInputKey, ensureRunInputKey } = await import('../../server/src/lib/run-inputs/keys')
const { ensureRunInputSet } = await import('../../server/src/lib/run-inputs/sets')
const { RUN_INPUT_SETS_READ } = await import('../../server/src/lib/constants')
const { adoptLegacyRunInputs } = await import('../../server/src/lib/run-inputs/legacy')

const uid = uuid(), tid = uuid(), sid = uuid()
const RUN = { kind: 'ai' as const, id: uuid() }
const OUT = 'Blurb (Output)'
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
  .run(sid, tid, uid, 'Leads', JSON.stringify(['Name', 'City', 'Country', OUT, 'Call']))
const insertRow = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
for (let i = 0; i < 6; i++) insertRow.run(uuid(), sid, uid, i, JSON.stringify({ Name: `N${i}`, City: `C${i}` }))

const raw = (i: number) => db.prepare('SELECT data FROM rows WHERE sheet_id = ? AND row_index = ?').pluck()
  .get(sid, i) as string
const setCell = (i: number, column: string, value: string) => db.prepare(
  `UPDATE rows SET data = json_set(data, '$."' || ? || '"', ?) WHERE sheet_id = ? AND row_index = ?`,
).run(column, value, sid, i)
const stale = (column: string) => {
  const c = columnStaleCheck(sid, uid, column)
  if (!c) return []
  return db.prepare(`SELECT row_index FROM rows WHERE sheet_id = ? AND ${c.sql} ORDER BY row_index`).pluck()
    .all(sid, ...c.params) as number[]
}
// An AI run with this prompt, its record inserted as the column's newest, stamping these rows.
const aiRun = (prompt: string, rows: number[]) => {
  db.prepare('INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status) VALUES (?,?,?,?,?,?)')
    .run(uuid(), sid, uid, OUT, prompt, 'completed')
  const s = aiRunStamper({ sheet_id: sid, user_id: uid, column_name: OUT, prompt, output_columns: null,
    use_openrouter_web_search: 0 })
  for (const i of rows) writeRunCells(RUN, sid, uid, i, [[OUT, `about ${i}`]], s.stamp(raw(i)))
}

await check('a stamp names its list: "<id>:<fingerprint>"', () => {
  aiRun('Describe /name in /city', [0, 1, 2])
  const key = ensureRunInputKey(sid, uid, OUT)
  const stamp = db.prepare(`SELECT json_extract(run_inputs, '$."' || ? || '"') FROM rows
    WHERE sheet_id = ? AND row_index = 0`).pluck().get(String(key), sid) as string
  assert.match(stamp, /^\d+:[0-9a-z]+$/)
  assert.equal(stamp.split(':')[1], runInputFingerprint(['N0', 'C0']))
  assert.deepEqual(stale(OUT), [])
})

await check('a setup reading one more column leaves the rows made before it as they were', () => {
  aiRun('Describe /name in /city, /country', [3])
  assert.deepEqual(stale(OUT), [])
  // Row 0 was made from Name and City only: a Country filled later changes nothing for it.
  setCell(0, 'Country', 'FR')
  assert.deepEqual(stale(OUT), [])
  setCell(0, 'City', 'Lyon')
  assert.deepEqual(stale(OUT), [0])
  // Row 3 was made from all three.
  setCell(3, 'Country', 'IT')
  assert.deepEqual(stale(OUT), [0, 3])
})

await check('the same columns in another order: older rows stay, new ones read their own order', () => {
  aiRun('In /city lives /name', [4])
  assert.deepEqual(stale(OUT), [0, 3])
  setCell(4, 'Name', 'Changed')
  setCell(1, 'Country', 'ES')
  assert.deepEqual(stale(OUT), [0, 3, 4])
})

await check('an HTTP API column: a request reading one more column leaves older rows as they were', () => {
  const run = (url: string, rows: number[]) => {
    const config = { requestConfig: { method: 'GET', url, headers: {} }, responseMapping: [] }
    db.prepare('INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name) VALUES (?,?,?,?,?,?)')
      .run(uuid(), sid, uid, JSON.stringify(config), 'completed', 'Call')
    const s = requestRunStamper({ sheet_id: sid, user_id: uid, master_column_name: 'Call' }, config as never)!
    for (const i of rows) writeRunCells(RUN, sid, uid, i, [['Call', '✅']], s.stamp(raw(i)))
  }
  run('https://api.test/?q={{Name}}', [0, 1])
  run('https://api.test/?q={{Name}}&c={{City}}', [2])
  assert.deepEqual(stale('Call'), [])
  setCell(1, 'City', 'Turin')
  assert.deepEqual(stale('Call'), [])
  setCell(2, 'City', 'Turin')
  assert.deepEqual(stale('Call'), [2])
})

await check('renaming an input rewrites the lists: rows keep their state and read the renamed column', async () => {
  aiRun('Describe /name in /city', [5]) // the list rows 0-2 were made from
  const before = stale(OUT), beforeCall = stale('Call')
  assert.ok(!before.includes(5))
  const r = await renameSheetColumn(sid, uid, 'City', 'Town')
  assert.ok('ok' in r, JSON.stringify(r))
  assert.deepEqual(stale(OUT), before)
  assert.deepEqual(stale('Call'), beforeCall)
  const lists = db.prepare('SELECT columns FROM run_input_sets').pluck().all() as string[]
  assert.ok(lists.every(l => !l.includes('"City"')) && lists.some(l => l.includes('"Town"')), lists.join(' '))
  setCell(5, 'Town', 'Pisa')
  assert.deepEqual(stale(OUT), [...before, 5].sort((a, b) => a - b))
})

await check('a stamp from before migration 066 reads against the run that was newest then, renames too', async () => {
  // Another column whose stamps were written before 066: no list named, and its run read Name and Country.
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?')
    .run(JSON.stringify(['Name', 'Town', 'Country', OUT, 'Call', 'Old']), sid)
  const legacy = uuid()
  db.prepare('INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status) VALUES (?,?,?,?,?,?)')
    .run(legacy, sid, uid, 'Old', 'Say hi to /name from /country', 'completed')
  const key = ensureRunInputKey(sid, uid, 'Old')
  for (const i of [0, 1]) {
    const d = JSON.parse(raw(i)) as Record<string, string>
    db.prepare(`UPDATE rows SET run_inputs = json_set(COALESCE(run_inputs, '{}'), '$."' || ? || '"', ?),
      data = json_set(data, '$.Old', 'hi') WHERE sheet_id = ? AND row_index = ?`)
      .run(String(key), runInputFingerprint([d.Name, d.Country]), sid, i)
  }
  // What migration 066 does for keys that exist when it runs, then the boot after it.
  const sql = fs.readFileSync(
    fileURLToPath(new URL('../../server/src/db/migrations/066_run_input_sets.sql', import.meta.url)), 'utf8')
  db.exec(sql.slice(sql.indexOf('UPDATE run_input_keys SET')))
  assert.equal(db.prepare('SELECT legacy_ai_run FROM run_input_keys WHERE id = ?').pluck().get(key), legacy)
  adoptLegacyRunInputs()
  const k = db.prepare('SELECT legacy_set, legacy_ai_run FROM run_input_keys WHERE id = ?').get(key) as
    { legacy_set: number | null; legacy_ai_run: string | null }
  assert.ok(k.legacy_set !== null && k.legacy_ai_run === null, JSON.stringify(k))
  // A newer setup reading Town changes nothing for those rows.
  db.prepare('INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status) VALUES (?,?,?,?,?,?)')
    .run(uuid(), sid, uid, 'Old', 'Say hi to /name in /town', 'completed')
  assert.deepEqual(stale('Old'), [])
  setCell(0, 'Town', 'Bonn')
  assert.deepEqual(stale('Old'), [])
  // A rename of one of its inputs: still read, under the new name.
  const r = await renameSheetColumn(sid, uid, 'Country', 'Land')
  assert.ok('ok' in r, JSON.stringify(r))
  assert.deepEqual(stale('Old'), [])
  setCell(1, 'Land', 'PT')
  assert.deepEqual(stale('Old'), [1])
})

await check(`a row made from a list older than the newest ${RUN_INPUT_SETS_READ} never reads out of date`, () => {
  // Row 5 is made from Name only, then 15 newer lists: still read. One more and every older list isn't.
  aiRun('Only /name', [5])
  const key = ensureRunInputKey(sid, uid, OUT)
  for (let n = 1; n < RUN_INPUT_SETS_READ; n++) ensureRunInputSet(key, uid, ['Name', ...Array(n).fill(null)])
  setCell(5, 'Name', 'Different')
  assert.deepEqual(stale(OUT), [5])
  ensureRunInputSet(key, uid, ['Name', ...Array(RUN_INPUT_SETS_READ).fill(null)])
  assert.deepEqual(stale(OUT), [])
})

await check('a setup back to a list older than the newest 16: the rows it fills read out of date again', () => {
  // The column reads Name only again, a list no reader checks any more: its new rows get a list that is read.
  aiRun('Only /name', [2])
  setCell(2, 'Name', 'Renamed')
  assert.deepEqual(stale(OUT), [2])
  // Row 5 keeps the old list's stamp: still never out of date.
  setCell(5, 'Name', 'Again')
  assert.deepEqual(stale(OUT), [2])
})

await check('one list is made once per key, and a deleted key takes its lists', () => {
  const key = ensureRunInputKey(sid, uid, 'Call')
  const a = ensureRunInputSet(key, uid, ['Name'])
  assert.equal(ensureRunInputSet(key, uid, ['Name']), a)
  assert.notEqual(ensureRunInputSet(key, uid, ['Town', 'Name']), a)
  db.transaction(() => deleteRunInputKey(sid, uid, 'Call')).immediate()
  assert.equal(db.prepare('SELECT COUNT(*) FROM run_input_sets WHERE key = ?').pluck().get(key), 0)
  assert.equal(columnStaleCheck(sid, uid, 'Call'), null)
})

if (failures) { console.error(`${failures} failed`); process.exit(1) }
console.log('all run-input-sets checks passed')
