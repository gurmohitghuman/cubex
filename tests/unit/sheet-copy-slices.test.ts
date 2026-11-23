// A copy's slice stops adding rows once it has taken SHEET_COPY_SLICE_MS (services/sheet-copy-job.ts), so a slow
// machine or a busy CPU gets smaller slices, not longer ones. Each case gives the copy a clock that moves a set time
// each time it's read (once for each row after a slice's first), so its slices are the same on every machine. At 1 ms
// a read, a 1,000-row copy goes in 25 slices or more, every row once and in order. At 50 ms a read (past the limit
// at each row), every slice still adds one row, so a copy always moves on. Slices are counted by the copy's cursor
// moving in its journal (a trigger on sheet_copy_jobs); its first row goes in with the journal.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import copyMod from '../../server/src/services/sheet-copy'
import jobMod from '../../server/src/services/sheet-copy-job'
import constMod from '../../server/src/lib/constants'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { copySheetValues } = copyMod as typeof import('../../server/src/services/sheet-copy')
const { setCopyClockForTests } = jobMod as typeof import('../../server/src/services/sheet-copy-job')
const { SHEET_COPY_SLICE_MS } = constMod as typeof import('../../server/src/lib/constants')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
let failures = 0
const ok = async (label: string, fn: () => Promise<void>) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

// The rows copied so far, each time the copy's cursor moved.
db.exec(`CREATE TEMP TABLE copy_steps (copied INTEGER);
  CREATE TEMP TRIGGER copy_step AFTER UPDATE OF copied ON sheet_copy_jobs
  BEGIN INSERT INTO copy_steps VALUES (NEW.copied); END`)

// A sheet of `n` rows (at 0, 2, 4…) copied with a clock moving `ms` each read: the copy's rows as
// [row_index, Name], and where its cursor stood after each slice.
async function copied(n: number, ms: number) {
  const tid = uuid(), src = uuid()
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, `T_${tid.slice(0, 8)}`)
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
    .run(src, tid, uid, 'Leads', 0, JSON.stringify(['Name']))
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < n; i++) ins.run(uuid(), src, uid, i * 2, JSON.stringify({ Name: `n${i}` }))
  }).immediate()
  db.exec('DELETE FROM copy_steps')
  let t = 0
  setCopyClockForTests(() => (t += ms))
  try {
    const out = await copySheetValues(uid, src)
    assert.ok('ok' in out && out.ok.rowsCopied === n, JSON.stringify(out))
    const rows = (db.prepare('SELECT row_index AS i, data FROM rows WHERE sheet_id = ? ORDER BY row_index')
      .all(out.ok.sheet.id) as Array<{ i: number; data: string }>).map(r => [r.i, JSON.parse(r.data).Name])
    return { rows, steps: db.prepare('SELECT copied FROM copy_steps ORDER BY rowid').pluck().all() as number[] }
  } finally { setCopyClockForTests(null) }
}
const inOrder = (n: number) => Array.from({ length: n }, (_, i) => [i, `n${i}`])

await ok(`at 1 ms a row, a slice stops at ${SHEET_COPY_SLICE_MS} ms: 1,000 rows go in 25 slices or more, `
  + 'every row once and in order', async () => {
  const { rows, steps } = await copied(1000, 1)
  assert.deepEqual(rows, inOrder(1000))
  assert.equal(steps[0], 1, 'the first row, with the journal')
  assert.ok(steps.length - 1 >= 25, `${steps.length - 1} slices: ${steps.join(', ')}`)
  assert.equal(steps[steps.length - 1], 1000)
  for (let k = 1; k < steps.length; k++) {
    const added = steps[k] - steps[k - 1]
    assert.ok(added >= 1 && added <= SHEET_COPY_SLICE_MS, `slice ${k} added ${added}: ${steps.join(', ')}`)
  }
})

await ok('at 50 ms a row, past the limit at each, every slice still adds one row', async () => {
  const { rows, steps } = await copied(30, 50)
  assert.deepEqual(rows, inOrder(30))
  assert.deepEqual(steps, Array.from({ length: 30 }, (_, k) => k + 1))
})

if (failures) { console.log(`${failures} sheet-copy-slices assertion(s) failed`); process.exit(1) }
console.log('All sheet-copy-slices assertions passed.')
