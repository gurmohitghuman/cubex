// A run's ⏳ clear (lib/placeholder-cells.ts) queues every row it clears once
// for each clean, formula and lookup column reading the run's columns, in the
// slice's own transaction. With none, its slices are HEAVY_SLICE_ROWS rows, as
// before, and run no checkpoint. With R of them, a slice holds
// PLACEHOLDER_CLEAR_QUEUE_ROWS / (1 + R) rows (at least 1), commits with
// SQLite's own checkpoint off and is followed by a checkpoint of its own. A
// column reading other columns, one with auto-run off and an auto-run that
// costs don't count. A run's clear that puts K columns back from its undo
// journal (lib/run-undo/clear-back.ts) holds at most
// PLACEHOLDER_CLEAR_BACK_ROWS / (1 + K) rows a slice, and the queue budget
// still caps it when columns read them. The real clear runs: each slice's size
// is read off the sheet after it (how many rows still hold ⏳), and the
// checkpoints through the database's pragma calls.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import cellsMod from '../../server/src/lib/placeholder-cells'
import constMod from '../../server/src/lib/constants'
import formulaMod from '../../server/src/services/formula-column'
import formulaRecMod from '../../server/src/lib/formula-columns'
import cleanMod from '../../server/src/services/clean-column'
const { clearProcessingPlaceholders, seedProcessingPlaceholders, PLACEHOLDER } =
  cellsMod as typeof import('../../server/src/lib/placeholder-cells')
const { HEAVY_SLICE_ROWS, PLACEHOLDER_CLEAR_QUEUE_ROWS, PLACEHOLDER_CLEAR_BACK_ROWS } =
  constMod as typeof import('../../server/src/lib/constants')
const { startFormulaColumn, setFormulaColumnAutorun } =
  formulaMod as typeof import('../../server/src/services/formula-column')
const { formulaColumnFor } = formulaRecMod as typeof import('../../server/src/lib/formula-columns')
const { startCleanColumn } = cleanMod as typeof import('../../server/src/services/clean-column')
const { db, uid, ok, done, idle, sheet, cells } = undoKit('run-clear-slices')
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
// Rows still holding ⏳ in any cell.
const held = db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND instr(data, ?) > 0').pluck()
const left = (sid: string) => held.get(sid, PLACEHOLDER) as number
// Rows holding earlier answers in Status, Answer and C1 to C5, then an HTTP run seeded over `columns` (its
// journal keeps them): the clear of `columns` puts them back.
const COLUMNS = ['Status', 'Answer', 'C1', 'C2', 'C3', 'C4', 'C5']
async function seededRun(n: number, columns: string[]) {
  const sid = sheet(Array.from({ length: n }, (_, i) => ({ Name: `n${i}`,
    ...Object.fromEntries(COLUMNS.map(c => [c, `${c} ${i}`])) })), ['Name', ...COLUMNS])
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,placeholder_work)
    VALUES (?,?,?,'{}','cancelled',?,'clearing')`).run(id, sid, uid, columns[0])
  await seedProcessingPlaceholders({ run: { kind: 'http', id }, sheetId: sid, userId: uid, columns, targets: null,
    lastRow: n - 1, live: () => true })
  return { sid, run: { kind: 'http' as const, id }, columns }
}

// The clear, watched: the rows each slice cleared and, in order, each slice
// (with SQLite's own checkpoint setting as its commit saw it) and each WAL
// checkpoint the clear ran.
const pragma = db.pragma
const auto = () => pragma.call(db, 'wal_autocheckpoint', { simple: true }) as number
async function clear(sid: string, opts: { columns?: string[]; run?: { kind: 'http'; id: string } } = {},
): Promise<{ sizes: number[]; events: string[] }> {
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
    await clearProcessingPlaceholders(sid, uid, opts.columns ?? ['Status', 'Answer'], () => {
      const now = left(sid)
      sizes.push(rowsLeft - now)
      rowsLeft = now
      events.push(`slice, auto-checkpoint ${auto() === 0 ? 'off' : 'on'}`)
    }, opts.run)
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
const expectClear = async (sid: string, want: { sizes: number[]; events: string[] },
  opts: Parameters<typeof clear>[1] = {}) => {
  const got = await clear(sid, opts)
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

// A run's clear putting K columns back: PLACEHOLDER_CLEAR_BACK_ROWS / (1 + K) rows a slice.
const backRows = (k: number) => Math.floor(PLACEHOLDER_CLEAR_BACK_ROWS / (1 + k))
const unwatched = (sizes: number[]) => ({ sizes, events: sizes.map(() => 'slice, auto-checkpoint on') })

await ok('a run putting one column back, none reading it: smaller slices, SQLite\'s own checkpoint on', async () => {
  const r = await seededRun(N, ['Answer'])
  await expectClear(r.sid, unwatched(split(N, backRows(1))), r)
  assert.deepEqual([cells(r.sid, 'Answer')[0], cells(r.sid, 'Answer')[N - 1]], ['Answer 0', `Answer ${N - 1}`])
})

await ok('two columns put back; a column the journal has no slot for doesn\'t count', async () => {
  const r = await seededRun(N, ['Status', 'Answer'])
  await expectClear(r.sid, unwatched(split(N, backRows(2))), { ...r, columns: ['Status', 'Answer', 'C1'] })
  assert.deepEqual(cells(r.sid, 'Status').slice(0, 2), ['Status 0', 'Status 1'])
})

await ok('three formulas read the column put back: the queue budget is smaller, so it holds', async () => {
  const r = await seededRun(N, ['Answer'])
  for (const k of [1, 2, 3]) await formula(r.sid, `F${k}`, `{{Answer}} + "${k}"`)
  await expectClear(r.sid, checkpointed(N, 3), r)
})

await ok('seven columns put back, one formula reading one: the journal\'s share is smaller, checkpointed', async () => {
  const r = await seededRun(N, COLUMNS)
  await formula(r.sid, 'F', '{{C5}} + "!"')
  assert.ok(backRows(7) < PLACEHOLDER_CLEAR_QUEUE_ROWS / 2)
  const sizes = split(N, backRows(7))
  await expectClear(r.sid,
    { sizes, events: sizes.flatMap(() => ['slice, auto-checkpoint off', 'wal_checkpoint(PASSIVE)']) }, r)
  assert.deepEqual(COLUMNS.map(c => cells(r.sid, c)[N - 1]), COLUMNS.map(c => `${c} ${N - 1}`))
})

done()
