// A run's ⏳ clear (lib/placeholder-cells.ts) queues every row it clears once
// for each clean, formula and lookup column reading the run's columns, in the
// slice's own transaction, so its slices shrink with those columns: a whole
// HEAVY_SLICE_ROWS slice with none, HEAVY_SLICE_ROWS / (1 + readers) with some,
// never fewer than PLACEHOLDER_CLEAR_MIN_SLICE_ROWS. A column reading other
// columns, one with auto-run off and an auto-run that costs don't count. The
// real clear runs; each slice's size is read off the sheet after it: how many
// rows still hold ⏳.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import cellsMod from '../../server/src/lib/placeholder-cells'
import constMod from '../../server/src/lib/constants'
import formulaMod from '../../server/src/services/formula-column'
import cleanMod from '../../server/src/services/clean-column'
const { clearProcessingPlaceholders, PLACEHOLDER } = cellsMod as typeof import('../../server/src/lib/placeholder-cells')
const { HEAVY_SLICE_ROWS, PLACEHOLDER_CLEAR_MIN_SLICE_ROWS } =
  constMod as typeof import('../../server/src/lib/constants')
const { startFormulaColumn } = formulaMod as typeof import('../../server/src/services/formula-column')
const { startCleanColumn } = cleanMod as typeof import('../../server/src/services/clean-column')
const { db, uid, ok, done, idle, sheet } = undoKit('run-clear-slices')
console.error = () => {}

// Rows whose Status and Answer hold ⏳, as an HTTP run (Status its status column) left them.
const sheetOf = (n: number) => sheet(Array.from({ length: n }, (_, i) =>
  ({ Name: `n${i}`, Status: PLACEHOLDER, Answer: PLACEHOLDER })), ['Name', 'Status', 'Answer'])
// A formula or clean column, filled (the sheet is busy until then).
const formula = async (sid: string, column: string, f: string, autoRun?: boolean) => {
  assert.ok('ok' in await startFormulaColumn(uid, sid, { column, formula: f, autoRun }), column)
  await idle(sid)
}
const clean = async (sid: string, source: string, column: string) => {
  assert.ok('ok' in await startCleanColumn(uid, sid, { source, cleaner: 'lowercase', column }), column)
  await idle(sid)
}
const held = db.prepare(`SELECT COUNT(*) FROM rows WHERE sheet_id = ?
  AND (json_extract(data, '$.Status') = ? OR json_extract(data, '$.Answer') = ?)`).pluck()
const left = (sid: string) => held.get(sid, PLACEHOLDER, PLACEHOLDER) as number

// The rows each slice of the clear cleared.
async function slices(sid: string): Promise<number[]> {
  await idle(sid)
  const sizes: number[] = []
  let before = left(sid)
  await clearProcessingPlaceholders(sid, uid, ['Status', 'Answer'], () => {
    const now = left(sid)
    sizes.push(before - now)
    before = now
  })
  assert.equal(left(sid), 0, 'every ⏳ was cleared')
  return sizes
}
// n rows in slices of `size`: every slice full but the last.
const split = (n: number, size: number) =>
  Array.from({ length: Math.ceil(n / size) }, (_, i) => Math.min(size, n - i * size))
const N = HEAVY_SLICE_ROWS + 1

await ok('no column reads the run\'s columns: slices of HEAVY_SLICE_ROWS, as before', async () => {
  const sid = sheetOf(N)
  await formula(sid, 'Who', '{{Name}} + "!"')
  await formula(sid, 'Off', '{{Answer}} + "?"', false)
  db.prepare(`INSERT INTO autorun_columns (id,user_id,sheet_id,status_column,kind,input_columns)
    VALUES (?,?,?,'Hook','http',?)`).run(uuid(), uid, sid, JSON.stringify(['Answer']))
  assert.deepEqual(await slices(sid), split(N, HEAVY_SLICE_ROWS))
})

await ok('one formula reads Answer (another reads that formula): slices of half as many rows', async () => {
  const sid = sheetOf(N)
  await formula(sid, 'F', '{{Answer}} ? "has " + {{Answer}} : "empty"')
  await formula(sid, 'F2', '{{F}} + "!"')
  assert.deepEqual(await slices(sid), split(N, Math.floor(HEAVY_SLICE_ROWS / 2)))
})

await ok('three read Status or Answer (one reads both, counted once): a quarter as many', async () => {
  const sid = sheetOf(N)
  await formula(sid, 'F', '{{Answer}} ? "has " + {{Answer}} : "empty"')
  await clean(sid, 'Status', 'Low')
  await formula(sid, 'Both', '{{Status}} + {{Answer}}')
  await clean(sid, 'Name', 'Name low')
  assert.deepEqual(await slices(sid), split(N, Math.floor(HEAVY_SLICE_ROWS / 4)))
})

await ok('so many read Answer that a share would be tiny: slices keep their floor', async () => {
  const readers = Math.ceil(HEAVY_SLICE_ROWS / PLACEHOLDER_CLEAR_MIN_SLICE_ROWS)
  const n = PLACEHOLDER_CLEAR_MIN_SLICE_ROWS * 2 + 1
  const sid = sheetOf(n)
  for (let i = 0; i < readers; i++) await clean(sid, 'Answer', `Low ${i}`)
  assert.ok(Math.floor(HEAVY_SLICE_ROWS / (1 + readers)) < PLACEHOLDER_CLEAR_MIN_SLICE_ROWS)
  assert.deepEqual(await slices(sid), split(n, PLACEHOLDER_CLEAR_MIN_SLICE_ROWS))
})

done()
