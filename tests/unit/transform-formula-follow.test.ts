// transform_column writing 50,000 rows (services/column-transform-pages.ts) into a column 0, 1 or 3 formula
// columns read, then the formulas following every row it wrote (services/derived-follow.ts), as in the server:
// they are told at once and follow by themselves, and the auto-run sweep (every 15 s) catches up one whose kick
// found the sheet still busy with the transform (on the Windows runner a page outlasts the kick). The event loop is
// sampled every 5 ms from the first call to the last formula done, as transform-pages.test.ts does: this thread never
// holds it 200 ms on the CPU in one stretch (loop-watch.ts: on a busy Mac the stretch itself went to 238 to 287 ms in
// two of three full unit runs, and passed alone), and every formula ends right. Where writers wait for a running
// checkpoint (writesWaitForCheckpoints: Windows and Linux), no write in turn (the pages, the formulas' slices) begins
// while one runs, so none waits inside it, off the CPU. On a 200,000-row sheet the longest stretch was 31, 50 and 70 ms
// (170 ms once with 3, no transaction in it); this size keeps the case near a minute. The Windows runner's disk took
// 7 minutes at it (3 formulas: written in 131 s, followed in 288 s, the loop held 128 ms): there it runs 10,000
// rows, in slices of the same size. Printed with the longest stretch: this thread's waits for the formula engine's
// answers inside it (lib/formula/host.ts waits for each one synchronously), and GC's pauses.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { undoKit } from './run-undo-kit'
import { heldText, loopWatch, turnWritesSeen } from './bulk-wal-kit'
import { sqliteWriteProbe, transactionLine } from './sqlite-write-probe'
const { db, uid, ok, done, idle, sheet, cells } = undoKit('transform-formula-follow')
const { startFormulaColumn } = await import('../../server/src/services/formula-column')
const { startDerivedFollow } = await import('../../server/src/services/derived-follow')
const { startAutorunLoop } = await import('../../server/src/services/autorun-loop')
const { transformColumn } = await import('../../server/src/services/column-transform')
const { checkpointAsked, closeWalCheckpointer, walCheckpointerIdle } =
  await import('../../server/src/lib/wal-checkpointer')
const { formulaHost } = await import('../../server/src/lib/formula/host')
startDerivedFollow()
startAutorunLoop()
console.error = () => {}
const probe = sqliteWriteProbe(db, process.env.DB_PATH!, checkpointAsked)
const turns = turnWritesSeen()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
// Each ask of the formula engine: when, how long this thread waited for its answer, and what it asked.
const asks: Array<{ at: number; ms: number; op: string; rows: number }> = []
const request = formulaHost.request.bind(formulaHost)
formulaHost.request = (msg, capMs) => {
  const at = performance.now()
  try { return request(msg, capMs) } finally {
    asks.push({ at, ms: performance.now() - at, op: msg.op, rows: msg.op === 'run' ? msg.rows.length : 0 })
  }
}

const N = process.platform === 'win32' ? 10_000 : 50_000
const LOOP_MS = 200
const NOTES = 'n'.repeat(200)
// Any row still queued for a formula (EXISTS: counting them every few ms would hold the loop itself).
const queued = db.prepare('SELECT EXISTS (SELECT 1 FROM autorun_pending WHERE user_id = ?)').pluck()

for (const formulas of [0, 1, 3]) {
  await ok(`a ${N}-row transform into a column ${formulas} formulas read: the loop never held 200 ms`, async () => {
    const sid = sheet(Array.from({ length: N }, (_, i) => ({ Name: `p${i}`, Out: `o${i}`, Notes: NOTES })),
      ['Name', 'Out', 'Notes'])
    for (let k = 0; k < formulas; k++) {
      assert.ok('ok' in await startFormulaColumn(uid, sid, { column: `F${k}`, formula: `{{Out}} + "-${k}"` }))
      await idle(sid)
    }
    await walCheckpointerIdle()
    probe.reset()
    asks.length = 0
    turns.reset()
    const watch = loopWatch(probe.records)
    await watch.ready
    const t0 = performance.now()
    for (let cursor: string | undefined; ;) {
      const out = await transformColumn(uid, { sheetId: sid, operation: 'upper', sourceColumn: 'Name',
        targetColumn: 'Out', ...(cursor === undefined ? {} : { cursor }) })
      assert.ok('ok' in out, JSON.stringify(out))
      cursor = out.ok.next_cursor
      if (cursor === undefined) break
    }
    const wrote = performance.now() - t0
    for (const end = Date.now() + 300_000; queued.get(uid) === 1 && Date.now() < end;) await sleep(20)
    const ms = performance.now() - t0
    const watched = watch()
    const w = probe.read()
    console.log(`      ${formulas} formulas: written in ${(wrote / 1000).toFixed(1)} s, followed by `
      + `${(ms / 1000).toFixed(1)} s; ${heldText(watched)}, ${w.transactions} transactions `
      + `(longest ${w.longestTransactionMs.toFixed(0)} ms)`)
    const inside = watched.inside.map(transactionLine).join(' | ')
    console.log(`        in the stretch this thread held longest: ${inside || 'no transaction'}`)
    const { at, ms: span } = watched.ownStretch
    const waits = asks.filter(a => a.at < at + span && a.at + a.ms > at)
    const most = asks.reduce((m, a) => Math.max(m, a.ms), 0)
    console.log(`        waits for the formula engine in it: ${waits.map(a => `${a.op} of ${a.rows} rows `
      + `${a.ms.toFixed(1)} ms`).join(', ') || 'none'}; of all ${asks.length} asks, the longest ${most.toFixed(1)} ms`)
    if (watched.cpuStretch.at !== at) {
      const onCpu = watched.cpuInside.map(transactionLine).join(' | ')
      console.log(`        in the stretch on the CPU longest: ${onCpu || 'no transaction'}`)
    }
    console.log(`        ${turns.text()}`)
    assert.equal(queued.get(uid), 0, 'a formula never followed')
    const outs = cells(sid, 'Out')
    assert.deepEqual(outs, Array.from({ length: N }, (_, i) => `P${i}`), 'Out written')
    for (let k = 0; k < formulas; k++) {
      assert.deepEqual(cells(sid, `F${k}`), outs.map(o => `${o}-${k}`), `F${k} follows`)
    }
    turns.check()
    assert.ok(watched.cpuMs < LOOP_MS,
      `this thread held the event loop ${watched.cpuMs.toFixed(0)} ms on the CPU in one stretch`)
  })
}

await closeWalCheckpointer()
done()
