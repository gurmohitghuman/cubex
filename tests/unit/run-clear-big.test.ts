// A run's ⏳ clear on 200,000 rows (lib/placeholder-cells.ts, lib/row-order.ts), through the code that stops runs.
// A run's first try on a new column, 20 formulas reading it, cancelled: the clear ends within 5 s, tells none of
// them anything, moves the sheet's data_version as its slices land (open grids lose the ⏳ as it goes), and never
// holds the event loop 100 ms. Stop all of 4 such runs on a sorted sheet (its row ids far from row order, so every
// page of them is sorted and the pages merged): the 4 clears never hold it 100 ms either, together. The longest
// stretch and transaction are printed. The formulas are started on one row and the rest come with their cells
// worked out already (what a fill of '' gives), so the setup stays short.
// On Windows it runs 50,000 rows and checks only what holds whatever the timing: none told, every ⏳ cleared, grids
// following. There the slice that asks the worker for a checkpoint now and then holds the server far longer (103
// and 1,039 ms on two runs, where the others held it 31 to 88 ms), in the WAL and checkpoint handling every bulk
// write shares, not in the clear; it is a to-do item of its own. The 100 ms and 5 s are proven on Linux; on Windows
// the loop hold and the longest transaction are still printed.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import { loopWatch } from './bulk-wal-kit'
import { sqliteWriteProbe, transactionLine } from './sqlite-write-probe'
const { db, uid, ok, done, idle, sheet } = undoKit('run-clear-big')
const { seedProcessingPlaceholders, PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
const { startFormulaColumn } = await import('../../server/src/services/formula-column')
const { cancelRun } = await import('../../server/src/services/run-lifecycle')
const { stopSheetRuns } = await import('../../server/src/services/sheet-runs-stop')
const { checkpointAsked, closeWalCheckpointer, walCheckpointerIdle } =
  await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}
const probe = sqliteWriteProbe(db, process.env.DB_PATH!, checkpointAsked)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const WINDOWS = process.platform === 'win32'
const N = WINDOWS ? 50_000 : 200_000
const READERS = 20
const CLEAR_MS = 5_000
const LOOP_MS = 100
const work = db.prepare('SELECT COUNT(*) FROM http_runs WHERE sheet_id = ? AND placeholder_work IS NOT NULL').pluck()
const version = db.prepare('SELECT data_version FROM sheets WHERE id = ?').pluck()
const held = db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND instr(data, ?) > 0').pluck()

// Rows 1 to N-1 of a sheet whose row 0 is there, in the order `at` gives their row indexes, with `cells`.
function addRows(sid: string, at: (i: number) => number, cells: (i: number) => object) {
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => { for (let i = 1; i < N; i++) ins.run(uuid(), sid, uid, at(i), JSON.stringify(cells(i))) })
    .immediate()
}
// A running HTTP run on `column`, ⏳ on every row, its journal keeping what the cells held (nothing).
async function running(sid: string, column: string): Promise<string> {
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','running',?)`).run(id, sid, uid, column)
  await seedProcessingPlaceholders({ run: { kind: 'http', id }, sheetId: sid, userId: uid, columns: [column],
    targets: null, lastRow: N - 1, live: () => true })
  return id
}
// `stop` until the sheet's runs are cleared, watched: how long, the event loop's longest stretch, the
// transactions, and how many data_version values a grid polling every 5 ms would have seen meanwhile.
async function watched(sid: string, stop: () => Promise<unknown>) {
  await walCheckpointerIdle()
  probe.reset()
  const seen = new Set([version.get(sid)])
  const poll = setInterval(() => seen.add(version.get(sid)), 5)
  const watch = loopWatch(probe.records)
  const t0 = performance.now()
  await stop()
  while ((work.get(sid) as number) > 0) await sleep(5)
  const ms = performance.now() - t0
  const { longest, inside } = watch()
  clearInterval(poll)
  const w = probe.read()
  console.log(`      ${(ms / 1000).toFixed(1)} s, loop held at most ${longest.ms.toFixed(0)} ms, ${w.transactions} `
    + `transactions (longest ${w.longestTransactionMs.toFixed(0)} ms), ${seen.size} data_version values seen`)
  console.log(`        in the longest stretch: ${inside.map(transactionLine).join(' | ') || 'no transaction'}`)
  return { ms, loopMs: longest.ms, seen: seen.size }
}

await ok(`a first run on a new column, ${READERS} formulas reading it, cancelled at ${N} rows: none told, grids `
  + `follow${WINDOWS ? '' : ', within 5 s, the loop never held 100 ms'}`, async () => {
  const columns = Array.from({ length: READERS }, (_, k) => `F${k}`)
  const sid = sheet([{ Name: 'n0' }], ['Name', 'Answer'])
  for (const [k, column] of columns.entries()) {
    assert.ok('ok' in await startFormulaColumn(uid, sid, { column, formula: `{{Answer}} + "-${k}"` }), column)
    await idle(sid)
  }
  addRows(sid, i => i, i => ({ Name: `n${i}`, ...Object.fromEntries(columns.map((c, k) => [c, `-${k}`])) }))
  db.prepare(`UPDATE autorun_columns SET watermark_row_index = ? WHERE sheet_id = ?`).run(N - 1, sid)
  const id = await running(sid, 'Answer')
  const m = await watched(sid, () => cancelRun('http', id, uid))
  assert.equal(held.get(sid, PLACEHOLDER), 0, 'every ⏳ cleared')
  assert.equal(db.prepare('SELECT COUNT(*) FROM autorun_pending WHERE user_id = ?').pluck().get(uid), 0,
    'rows queued for the formulas')
  assert.ok(m.seen >= 10, `a grid saw data_version move ${m.seen - 1} times while the clear went`)
  if (WINDOWS) return
  assert.ok(m.ms < CLEAR_MS, `the clear took ${m.ms.toFixed(0)} ms`)
  assert.ok(m.loopMs < LOOP_MS, `the event loop was held ${m.loopMs.toFixed(0)} ms`)
})

await ok(`Stop all of 4 runs on a sorted sheet of ${N} rows: every ⏳ cleared`
  + `${WINDOWS ? '' : ', the loop never held 100 ms'}`, async () => {
  const columns = ['A', 'B', 'C', 'D']
  const sid = sheet([{ Name: 'n0' }], ['Name', ...columns])
  // Row indexes far from storage order, as a sort leaves them: a step coprime with N.
  addRows(sid, i => (i * 7_919) % N, i => ({ Name: `n${i}` }))
  for (const c of columns) await running(sid, c)
  const m = await watched(sid, () => stopSheetRuns(uid, sid))
  assert.equal(held.get(sid, PLACEHOLDER), 0, 'every ⏳ cleared')
  if (!WINDOWS) assert.ok(m.loopMs < LOOP_MS, `the event loop was held ${m.loopMs.toFixed(0)} ms`)
})

await closeWalCheckpointer()
done()
