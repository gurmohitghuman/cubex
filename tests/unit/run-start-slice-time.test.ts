// A run start that tells clean, formula or lookup columns reading its columns (lib/derived-spans.ts) reads every
// row's cells once more, so its seed slices are sized by time while such columns exist: as many rows as fit
// BULK_SLICE_MS at the last slice's pace (lib/placeholder-cells.ts, lib/placeholder-rule-seed.ts), from
// FIRST_TIMED_PAGE up to HEAVY_SLICE_ROWS. Without them a slice stays HEAVY_SLICE_ROWS rows. Each case gives the
// seed a clock that moves a set time each time it's read (at a slice's start and end), so the slices are the same
// on every machine; each row written is counted with the transaction it was written in.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import cellsMod from '../../server/src/lib/placeholder-cells'
import ruleSeedMod from '../../server/src/lib/placeholder-rule-seed'
import clockMod from '../../server/src/lib/slice-clock'
import constMod from '../../server/src/lib/constants'
import writeMod from '../../server/src/services/derived-write'
import formulaMod from '../../server/src/services/formula-column'
import condMod from '../../server/src/lib/run-condition'
import walMod from '../../server/src/lib/wal-checkpointer'
const { seedProcessingPlaceholders, PLACEHOLDER } = cellsMod as typeof import('../../server/src/lib/placeholder-cells')
const { seedPlaceholdersByRule } = ruleSeedMod as typeof import('../../server/src/lib/placeholder-rule-seed')
const { setSliceClockForTests } = clockMod as typeof import('../../server/src/lib/slice-clock')
const { HEAVY_SLICE_ROWS } = constMod as typeof import('../../server/src/lib/constants')
const { FIRST_TIMED_PAGE, pageByTime } = writeMod as typeof import('../../server/src/services/derived-write')
const { startFormulaColumn } = formulaMod as typeof import('../../server/src/services/formula-column')
const { checkRule } = condMod as typeof import('../../server/src/lib/run-condition')
const { closeWalCheckpointer } = walMod as typeof import('../../server/src/lib/wal-checkpointer')

const { db, uid, ok, done, idle, sheet, cells } = undoKit('run-start-slice-time')

// Each transaction counted as it starts (db.transaction wrapped, as bulk-slice-time.test.ts does), and every row
// written kept with the transaction it was in.
let tx = 0
const realTransaction = db.transaction
db.transaction = ((fn: (...a: unknown[]) => unknown) => {
  const t = realTransaction.call(db, fn) as unknown as Record<string, (...a: unknown[]) => unknown>
  const counted = (call: (...a: unknown[]) => unknown) => (...a: unknown[]) => { tx++; return call(...a) }
  const w = counted(t as unknown as (...a: unknown[]) => unknown) as unknown as Record<string, unknown>
  for (const k of ['default', 'deferred', 'immediate', 'exclusive']) w[k] = counted(t[k])
  return w
}) as unknown as typeof db.transaction
db.function('slice_tx', { deterministic: false }, () => tx)
db.exec(`CREATE TEMP TABLE written (tx INTEGER, sheet TEXT, i INTEGER);
  CREATE TEMP TRIGGER row_written AFTER UPDATE OF data ON rows
  BEGIN INSERT INTO written VALUES (slice_tx(), NEW.sheet_id, NEW.row_index); END`)

const upTo = (n: number) => Array.from({ length: n }, (_, i) => i)
// A sheet of n rows whose Out holds an earlier answer (Flag yes on even rows), and with `reader` a formula reading
// Out, filled before the run.
async function scene(n: number, reader: boolean) {
  const sid = sheet(upTo(n).map(i => ({ Flag: i % 2 ? 'no' : 'yes', Out: `Old ${i}` })), ['Flag', 'Status', 'Out'])
  if (reader) {
    assert.ok('ok' in await startFormulaColumn(uid, sid, { column: 'F', formula: '{{Out}} + "!"' }))
    await idle(sid)
  }
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,placeholder_work)
    VALUES (?,?,?,'{}','pending','Status','seeding')`).run(id, sid, uid)
  return { sid, run: { kind: 'http' as const, id } }
}
// `seed` run with a clock moving `ms` each read: how many rows each of its transactions wrote.
async function sliced(sid: string, ms: number, seed: () => Promise<unknown>): Promise<number[]> {
  db.exec('DELETE FROM written')
  let t = 0
  setSliceClockForTests(() => (t += ms))
  try { await seed() } finally { setSliceClockForTests(null) }
  return db.prepare('SELECT COUNT(*) FROM written WHERE sheet = ? GROUP BY tx ORDER BY tx').pluck().all(sid) as number[]
}
const plainSeed = (sid: string, run: { kind: 'http'; id: string }, n: number) => () => seedProcessingPlaceholders({
  run, sheetId: sid, userId: uid, columns: ['Status', 'Out'], targets: null, lastRow: n - 1, live: () => true })
// The slices a timed seed of n rows takes at `ms` a slice.
function timedSlices(n: number, ms: number): number[] {
  const out: number[] = []
  for (let left = n, page = FIRST_TIMED_PAGE; left > 0; page = pageByTime(page, ms)) {
    out.push(Math.min(page, left))
    left -= Math.min(page, left)
  }
  return out
}
const told = (sid: string) => db.prepare(`SELECT COUNT(*) FROM derived_spans s, json_each(s.rowids)
  WHERE s.sheet_id = ?`).pluck().get(sid) as number

await ok('with a formula reading the run\'s column, at 100 ms a slice: FIRST_TIMED_PAGE rows a slice', async () => {
  const { sid, run } = await scene(1_000, true)
  const slices = await sliced(sid, 100, plainSeed(sid, run, 1_000))
  assert.deepEqual(slices, timedSlices(1_000, 100))
  assert.ok(slices.every(k => k <= FIRST_TIMED_PAGE), slices.join(', '))
  assert.deepEqual(cells(sid, 'Out'), upTo(1_000).map(() => PLACEHOLDER))
  assert.equal(told(sid), 1_000, 'every row told once')
})

await ok('with a formula reading it, at 1 ms a slice: slices grow to fit the time, to HEAVY_SLICE_ROWS', async () => {
  const { sid, run } = await scene(12_000, true)
  const slices = await sliced(sid, 1, plainSeed(sid, run, 12_000))
  assert.deepEqual(slices, timedSlices(12_000, 1))
  assert.equal(Math.max(...slices), HEAVY_SLICE_ROWS)
  assert.equal(told(sid), 12_000, 'every row told once')
})

await ok('with no column reading it, at 100 ms a slice: HEAVY_SLICE_ROWS rows a slice, nothing told', async () => {
  const { sid, run } = await scene(6_000, false)
  const slices = await sliced(sid, 100, plainSeed(sid, run, 6_000))
  assert.deepEqual(slices, [HEAVY_SLICE_ROWS, 6_000 - HEAVY_SLICE_ROWS])
  assert.equal(told(sid), 0)
})

await ok('an "Only run if" seed with a formula reading it, at 100 ms a slice: FIRST_TIMED_PAGE rows', async () => {
  const { sid, run } = await scene(300, true)
  const checked = checkRule('{{Flag}} is "yes"', ['Flag', 'Status', 'Out'])
  const slices = await sliced(sid, 100, () => seedPlaceholdersByRule({
    run, sheetId: sid, userId: uid, columns: ['Status', 'Out'], targets: null, lastRow: 299, live: () => true,
    rule: { tree: checked.tree, columns: checked.columns, markColumn: 'Status' } }))
  assert.deepEqual(slices, timedSlices(300, 100), 'passing and kept-out rows of a slice in one transaction')
  assert.deepEqual(cells(sid, 'Out'), upTo(300).map(i => (i % 2 ? '' : PLACEHOLDER)))
  assert.equal(told(sid), 300, 'every row told once')
})

db.transaction = realTransaction
await closeWalCheckpointer()
done()
