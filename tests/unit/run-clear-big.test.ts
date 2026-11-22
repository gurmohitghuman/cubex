// A run's ⏳ clear on 200,000 rows (lib/placeholder-cells.ts, lib/row-order.ts), through the code that stops runs.
// A run's first try on a new column, 20 formulas reading it, cancelled: the clear ends within 5 s, tells none of
// them anything, moves the sheet's data_version as its slices land (open grids lose the ⏳ as it goes), and never
// holds the event loop 100 ms. A run over earlier answers that 20 formulas read, cancelled: the clear puts every
// answer back and tells the formulas by span (lib/derived-spans.ts), queuing nothing, within 5 s and never holding
// the loop 100 ms; then the formulas, kicked as it ends, work the rows out and end right, the loop never held
// 100 ms. Stop all of 4 runs over earlier answers on a sorted sheet (its row ids far from row order, so every page
// of them is sorted and the pages merged): the 4 clears never hold it 100 ms either, together. The longest stretch
// and transaction are printed. The formulas are started on one row and the rest come with their cells worked out
// already (what a fill gives), so the setup stays short.
// On Windows it runs 50,000 rows and checks only what holds whatever the timing: none told, every ⏳ cleared, grids
// following. There a slice that committed while the worker copied the WAL back held the server far longer (103
// and 1,039 ms on two runs). No slice overlaps a checkpoint there now (wal-checkpoint-waits.test.ts), but a slice
// still takes 50 to 80 ms now and then with no checkpoint running, as on main, and the loop held up to 85 ms. The
// 100 ms and 5 s are proven on Linux; on Windows the loop hold and the longest transaction are still printed.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { readFileSync, statSync } from 'node:fs'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import { heldText, loopWatch, type LoopWatched } from './loop-watch'
import { sqliteWriteProbe, transactionLine } from './sqlite-write-probe'
const { db, uid, ok, done, idle, sheet, cells } = undoKit('run-clear-big')
const { seedProcessingPlaceholders, PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
const { startFormulaColumn } = await import('../../server/src/services/formula-column')
const { cancelRun } = await import('../../server/src/services/run-lifecycle')
const { kickDerivedFollow } = await import('../../server/src/services/derived-follow')
const { onFollowQueued } = await import('../../server/src/lib/autorun-kick')
const { PLACEHOLDER_CLEAR_BACK_ROWS } = await import('../../server/src/lib/constants')
const { stopSheetRuns } = await import('../../server/src/services/sheet-runs-stop')
const { checkpointAsked, closeWalCheckpointer, walCheckpointerIdle } =
  await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}
const probe = sqliteWriteProbe(db, process.env.DB_PATH!, checkpointAsked)
// Experiment only (removed before review): WAL_EXPERIMENT=sized makes the -wal file its full size at each reset,
// WAL_EXPERIMENT=grown leaves it growing from empty; WALX lines sum up each clear's transactions.
const { setWalFileSizingForTests } = await import('../../server/src/lib/wal-file')
if (process.env.WAL_EXPERIMENT) setWalFileSizingForTests(process.env.WAL_EXPERIMENT === 'sized')
// WAL_WAIT=on: writers wait for a running checkpoint, as on Windows; off: they write on meanwhile.
const { setWritesWaitForCheckpointsForTests } = await import('../../server/src/lib/wal-checkpointer')
if (process.env.WAL_WAIT) setWritesWaitForCheckpointsForTests(process.env.WAL_WAIT === 'on')
const walSizeNow = () => { try { return statSync(`${process.env.DB_PATH}-wal`).size } catch { return 0 } }
let clearN = 0
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const WINDOWS = process.platform === 'win32'
const N = WINDOWS ? 50_000 : 200_000
const READERS = 20
const CLEAR_MS = 5_000
const LOOP_MS = 100
const work = db.prepare('SELECT COUNT(*) FROM http_runs WHERE sheet_id = ? AND placeholder_work IS NOT NULL').pluck()
const version = db.prepare('SELECT data_version FROM sheets WHERE id = ?').pluck()
const held = db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND instr(data, ?) > 0').pluck()
const queued = db.prepare('SELECT COUNT(*) FROM autorun_pending WHERE user_id = ?').pluck()
const spans = db.prepare(`SELECT (SELECT COUNT(*) FROM derived_spans WHERE sheet_id = ?) AS spans,
  (SELECT COUNT(*) FROM derived_span_marks WHERE span_id IN
    (SELECT id FROM derived_spans WHERE sheet_id = ?)) AS marks`)
const spansOf = (sid: string) => spans.get(sid, sid) as { spans: number; marks: number }

// Rows 1 to N-1 of a sheet whose row 0 is there, in the order `at` gives their row indexes, with `cells`.
function addRows(sid: string, at: (i: number) => number, cells: (i: number) => object) {
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => { for (let i = 1; i < N; i++) ins.run(uuid(), sid, uid, at(i), JSON.stringify(cells(i))) })
    .immediate()
}
// A running HTTP run on `column`, ⏳ on every row, its journal keeping what the cells held.
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
  const walAtStart = walSizeNow()
  const meminfo = () => { try { return readFileSync('/proc/meminfo', 'utf8') } catch { return '' } }
  const memMB = (k: string) => Math.round(Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(meminfo())?.[1] ?? 0) / 1024)
  const disk0 = { t: +(Date.now() / 1000).toFixed(1), dirtyMB: memMB('Dirty'), writebackMB: memMB('Writeback') }
  const seen = new Set([version.get(sid)])
  const poll = setInterval(() => seen.add(version.get(sid)), 5)
  const watch = loopWatch(probe.records)
  await watch.ready
  const t0 = performance.now()
  let ms = 0
  let watchedLoop: LoopWatched
  try {
    await stop()
    while ((work.get(sid) as number) > 0) await sleep(5)
    ms = performance.now() - t0
  } finally {
    clearInterval(poll)
    watchedLoop = watch()
  }
  const w = probe.read()
  {
    const rs = probe.records()
    const off = (r: { ms: number; cpuMs: number }) => r.ms - r.cpuMs
    const top = [...rs].sort((x, y) => off(y) - off(x))[0]
    const waits = rs.filter(r => off(r) >= 20).map(r => ({ ms: +r.ms.toFixed(1), cpu: +r.cpuMs.toFixed(1),
      grew: r.grew, ckpt: r.checkpointing, frames: r.before.log }))
    const slow = rs.filter(r => r.ms >= 40).map(r => ({ n: r.n, ms: +r.ms.toFixed(1), cpu: +r.cpuMs.toFixed(1),
      grew: r.grew, ckpt: r.checkpointing, frames: r.before.log, copied: r.before.checkpointed,
      after: `${r.after.log}/${r.after.checkpointed}` }))
    // When the checkpoint was first asked, and when it first had frames copied: how long its first step took.
    const ask = rs.find(r => r.checkpointing)
    const copy = rs.find(r => r.after.checkpointed > 0)
    const firstCopy = ask && copy ? { askFrames: ask.before.log, copyFrames: copy.after.log,
      ms: +(copy.at + copy.ms - ask.at).toFixed(0) } : null
    // Transactions with a checkpoint in flight at their start or end, and the rest: how long, how long off the CPU.
    const sum = (xs: typeof rs) => ({ n: xs.length, ms: +xs.reduce((a, r) => a + r.ms, 0).toFixed(0),
      msMax: +Math.max(0, ...xs.map(r => r.ms)).toFixed(1), off: +xs.reduce((a, r) => a + off(r), 0).toFixed(0),
      offMax: +Math.max(0, ...xs.map(off)).toFixed(1), off10: xs.filter(r => off(r) >= 10).length })
    const overlap = sum(rs.filter(r => r.checkpointing || r.askedEnd))
    const apart = sum(rs.filter(r => !r.checkpointing && !r.askedEnd))
    console.log('WALX ' + JSON.stringify({ mode: process.env.WAL_WAIT ?? process.env.WAL_EXPERIMENT ?? 'none',
      clear: ++clearN, clearMs: +ms.toFixed(0), overlap, apart,
      walAtStart, walAtEnd: walSizeNow(), tx: rs.length, grew: rs.filter(r => r.grew).length,
      longest: +w.longestTransactionMs.toFixed(1), loop: +watchedLoop.ownMs.toFixed(1),
      maxOff: top ? +off(top).toFixed(1) : 0, off20: waits.length, off40: waits.filter(x => x.ms - x.cpu >= 40).length,
      waits, slow, firstCopy, ...disk0, dirtyEndMB: memMB('Dirty'), writebackEndMB: memMB('Writeback') }))
  }
  console.log(`      ${(ms / 1000).toFixed(1)} s, ${heldText(watchedLoop)}, ${w.transactions} `
    + `transactions (longest ${w.longestTransactionMs.toFixed(0)} ms), ${seen.size} data_version values seen`)
  const inside = watchedLoop.inside.map(transactionLine).join(' | ')
  console.log(`        in the stretch this thread held longest: ${inside || 'no transaction'}`)
  return { ms, loopMs: watchedLoop.ownMs, seen: seen.size }
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
  assert.equal(queued.get(uid), 0, 'rows queued for the formulas')
  assert.deepEqual(spansOf(sid), { spans: 0, marks: 0 }, 'rows told the formulas')
  assert.ok(m.seen >= 10, `a grid saw data_version move ${m.seen - 1} times while the clear went`)
  if (WINDOWS) return
  assert.ok(m.ms < CLEAR_MS, `the clear took ${m.ms.toFixed(0)} ms`)
  assert.ok(m.loopMs < LOOP_MS, `the event loop was held ${m.loopMs.toFixed(0)} ms`)
})

// The formulas told by span, kicked as the clear ended (as in the server), until none has a span left, watched.
async function caughtUp(sid: string) {
  const watch = loopWatch(probe.records)
  await watch.ready
  const t0 = performance.now()
  let watchedLoop: LoopWatched
  try {
    while (spansOf(sid).marks > 0) await sleep(20)
  } finally { watchedLoop = watch() }
  const ms = performance.now() - t0
  console.log(`      the formulas caught up in ${(ms / 1000).toFixed(1)} s, ${heldText(watchedLoop)}`)
  console.log(`        in the stretch this thread held longest: ${watchedLoop.inside.map(transactionLine).join(' | ')
    || 'no transaction'}`)
  return { ms, loopMs: watchedLoop.ownMs }
}

await ok(`a run over earlier answers ${READERS} formulas read, cancelled at ${N} rows: every answer back, told by `
  + `span, none queued${WINDOWS ? '' : ', within 5 s, the loop never held 100 ms'}; the formulas catch up`,
  async () => {
  const columns = Array.from({ length: READERS }, (_, k) => `F${k}`)
  const sid = sheet([{ Name: 'n0', Answer: 'a0' }], ['Name', 'Answer'])
  for (const [k, column] of columns.entries()) {
    assert.ok('ok' in await startFormulaColumn(uid, sid, { column, formula: `{{Answer}} + "-${k}"` }), column)
    await idle(sid)
  }
  addRows(sid, i => i, i => ({ Name: `n${i}`, Answer: `a${i}`,
    ...Object.fromEntries(columns.map((c, k) => [c, `a${i}-${k}`])) }))
  db.prepare(`UPDATE autorun_columns SET watermark_row_index = ? WHERE sheet_id = ?`).run(N - 1, sid)
  const id = await running(sid, 'Answer')
  onFollowQueued(kickDerivedFollow)
  try {
    const m = await watched(sid, () => cancelRun('http', id, uid))
    assert.equal(held.get(sid, PLACEHOLDER), 0, 'every ⏳ cleared')
    assert.equal(queued.get(uid), 0, 'rows queued for the formulas')
    // One span a slice of the clear (one column put back and read: two journal lookups a cell).
    const told = Math.ceil(N / Math.floor(PLACEHOLDER_CLEAR_BACK_ROWS / 3))
    assert.deepEqual(spansOf(sid), { spans: told, marks: told * READERS }, 'a span a slice, a mark per formula')
    if (!WINDOWS) {
      assert.ok(m.ms < CLEAR_MS, `the clear took ${m.ms.toFixed(0)} ms`)
      assert.ok(m.loopMs < LOOP_MS, `the event loop was held ${m.loopMs.toFixed(0)} ms`)
    }
    const c = await caughtUp(sid)
    const answers = Array.from({ length: N }, (_, i) => `a${i}`)
    assert.deepEqual(cells(sid, 'Answer'), answers, 'every answer back')
    for (const [k, column] of columns.entries()) {
      assert.deepEqual(cells(sid, column), answers.map(a => `${a}-${k}`), `${column} follows`)
    }
    assert.equal(queued.get(uid), 0, 'nothing left queued')
    if (!WINDOWS) assert.ok(c.loopMs < LOOP_MS, `the event loop was held ${c.loopMs.toFixed(0)} ms`)
  } finally { onFollowQueued(() => {}) }
})

await ok(`Stop all of 4 runs over earlier answers on a sorted sheet of ${N} rows: every answer back`
  + `${WINDOWS ? '' : ', the loop never held 100 ms'}`, async () => {
  const columns = ['A', 'B', 'C', 'D']
  const sid = sheet([{ Name: 'n0' }], ['Name', ...columns])
  // Row indexes far from storage order, as a sort leaves them: a step coprime with N.
  addRows(sid, i => (i * 7_919) % N, i => ({ Name: `n${i}`, ...Object.fromEntries(columns.map(c => [c, `${c}${i}`])) }))
  for (const c of columns) await running(sid, c)
  const m = await watched(sid, () => stopSheetRuns(uid, sid))
  assert.equal(held.get(sid, PLACEHOLDER), 0, 'every ⏳ cleared')
  const back = db.prepare(`SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND json_extract(data, '$.D') = 'D' || substr(
    json_extract(data, '$.Name'), 2)`).pluck().get(sid)
  assert.equal(back, N - 1, 'every answer back')
  if (!WINDOWS) assert.ok(m.loopMs < LOOP_MS, `the event loop was held ${m.loopMs.toFixed(0)} ms`)
})

await closeWalCheckpointer()
done()
