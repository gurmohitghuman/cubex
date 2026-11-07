// A run's ⏳ clear (lib/placeholder-cells.ts) queues every row it clears once
// for each clean, formula and lookup column reading the run's columns, in the
// slice's own transaction. With none, its slices are HEAVY_SLICE_ROWS rows, as
// before, and run no checkpoint. With R of them, a slice holds
// PLACEHOLDER_CLEAR_QUEUE_ROWS / (1 + R) rows (at least 1), commits with
// SQLite's own checkpoint off and is followed by a checkpoint of its own. A
// column reading other columns, one with auto-run off and an auto-run that
// costs don't count. The real clear runs: each slice's size is read off the
// sheet after it (how many rows still hold ⏳), and the checkpoints through
// the database's pragma calls.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import cellsMod from '../../server/src/lib/placeholder-cells'
import constMod from '../../server/src/lib/constants'
import formulaMod from '../../server/src/services/formula-column'
import formulaRecMod from '../../server/src/lib/formula-columns'
import cleanMod from '../../server/src/services/clean-column'
const { clearProcessingPlaceholders, PLACEHOLDER } = cellsMod as typeof import('../../server/src/lib/placeholder-cells')
const { HEAVY_SLICE_ROWS, PLACEHOLDER_CLEAR_QUEUE_ROWS } = constMod as typeof import('../../server/src/lib/constants')
const { startFormulaColumn, setFormulaColumnAutorun } =
  formulaMod as typeof import('../../server/src/services/formula-column')
const { formulaColumnFor } = formulaRecMod as typeof import('../../server/src/lib/formula-columns')
const { startCleanColumn } = cleanMod as typeof import('../../server/src/services/clean-column')
const { db, uid, ok, done, idle, sheet } = undoKit('run-clear-slices')
console.error = () => {}

// Rows whose Status and Answer hold ⏳, as an HTTP run (Status its status column) left them.
const sheetOf = (n: number) => sheet(Array.from({ length: n }, (_, i) =>
  ({ Name: `n${i}`, Status: PLACEHOLDER, Answer: PLACEHOLDER })), ['Name', 'Status', 'Answer'])
// A formula or clean column, filled (the sheet is busy until then).
const formula = async (sid: string, column: string, f: string) => {
  assert.ok('ok' in await startFormulaColumn(uid, sid, { column, formula: f }), column)
  await idle(sid)
}
const clean = async (sid: string, source: string, column: string) => {
  assert.ok('ok' in await startCleanColumn(uid, sid, { source, cleaner: 'lowercase', column }), column)
  await idle(sid)
}
const held = db.prepare(`SELECT COUNT(*) FROM rows WHERE sheet_id = ?
  AND (json_extract(data, '$.Status') = ? OR json_extract(data, '$.Answer') = ?)`).pluck()
const left = (sid: string) => held.get(sid, PLACEHOLDER, PLACEHOLDER) as number

// The clear, watched: the rows each slice cleared and, in order, each slice
// (with SQLite's own checkpoint setting as its commit saw it) and each WAL
// checkpoint the clear ran.
const pragma = db.pragma
const auto = () => pragma.call(db, 'wal_autocheckpoint', { simple: true }) as number
async function clear(sid: string): Promise<{ sizes: number[]; events: string[] }> {
  await idle(sid)
  const sizes: number[] = []
  const events: string[] = []
  const before = auto()
  let rowsLeft = left(sid)
  db.pragma = ((source: string, options?: object) => {
    if (source.startsWith('wal_checkpoint')) events.push(source)
    return pragma.call(db, source, options)
  }) as typeof db.pragma
  try {
    await clearProcessingPlaceholders(sid, uid, ['Status', 'Answer'], () => {
      const now = left(sid)
      sizes.push(rowsLeft - now)
      rowsLeft = now
      events.push(`slice, auto-checkpoint ${auto() === 0 ? 'off' : 'on'}`)
    })
  } finally {
    db.pragma = pragma
  }
  assert.equal(left(sid), 0, 'every ⏳ was cleared')
  assert.equal(auto(), before, 'SQLite\'s own checkpoint is as it was')
  return { sizes, events }
}
// n rows in slices of `size`: every slice full but the last.
const split = (n: number, size: number) =>
  Array.from({ length: Math.ceil(n / size) }, (_, i) => Math.min(size, n - i * size))
// What a clear of n rows does with R reading columns: slices of the queue
// budget's share, each committed with SQLite's own checkpoint off, then checkpointed.
const checkpointed = (n: number, readers: number) => {
  const sizes = split(n, Math.floor(PLACEHOLDER_CLEAR_QUEUE_ROWS / (1 + readers)))
  return { sizes, events: sizes.flatMap(() => ['slice, auto-checkpoint off', 'wal_checkpoint(PASSIVE)']) }
}
const expectClear = async (sid: string, want: { sizes: number[]; events: string[] }) => {
  const got = await clear(sid)
  assert.deepEqual(got.sizes, want.sizes, 'rows per slice')
  assert.deepEqual(got.events, want.events, 'slices and checkpoints')
}
const N = HEAVY_SLICE_ROWS + 1

await ok('no column reads the run\'s columns: slices of HEAVY_SLICE_ROWS and no checkpoint, as before', async () => {
  const sid = sheetOf(N)
  await formula(sid, 'Who', '{{Name}} + "!"')
  // Auto-run on, then off through the column's own setting: its entry stays, reading Answer.
  await formula(sid, 'Off', '{{Answer}} + "?"')
  assert.ok('ok' in await setFormulaColumnAutorun(uid, sid, formulaColumnFor(sid, uid, 'Off')!, false))
  assert.deepEqual(db.prepare(`SELECT enabled, input_columns FROM autorun_columns
    WHERE sheet_id = ? AND status_column = 'Off'`).get(sid), { enabled: 0, input_columns: '["Answer"]' })
  db.prepare(`INSERT INTO autorun_columns (id,user_id,sheet_id,status_column,kind,input_columns)
    VALUES (?,?,?,'Hook','http',?)`).run(uuid(), uid, sid, JSON.stringify(['Answer']))
  const sizes = split(N, HEAVY_SLICE_ROWS)
  await expectClear(sid, { sizes, events: sizes.map(() => 'slice, auto-checkpoint on') })
})

await ok('one formula reads Answer (another reads that formula): half the queue budget, checkpointed', async () => {
  const sid = sheetOf(N)
  await formula(sid, 'F', '{{Answer}} ? "has " + {{Answer}} : "empty"')
  await formula(sid, 'F2', '{{F}} + "!"')
  await expectClear(sid, checkpointed(N, 1))
})

await ok('three read Status or Answer (one reads both, counted once): a quarter, checkpointed', async () => {
  const sid = sheetOf(N)
  await formula(sid, 'F', '{{Answer}} ? "has " + {{Answer}} : "empty"')
  await clean(sid, 'Status', 'Low')
  await formula(sid, 'Both', '{{Status}} + {{Answer}}')
  await clean(sid, 'Name', 'Name low')
  await expectClear(sid, checkpointed(N, 3))
})

await ok('twenty read Answer: slices of 95 rows, checkpointed (no floor brings big slices back)', async () => {
  const n = 95 * 2 + 1
  const sid = sheetOf(n)
  for (let i = 0; i < 20; i++) await clean(sid, 'Answer', `Low ${i}`)
  const want = checkpointed(n, 20)
  assert.deepEqual(want.sizes, [95, 95, 1])
  await expectClear(sid, want)
})

done()
