// transform_column writing 50,000 rows (services/column-transform-pages.ts) into a column 0, 1 or 3 formula
// columns read, then the formulas following every row it wrote (services/derived-follow.ts), as in the server:
// they are told at once and follow by themselves, and the auto-run sweep (every 15 s) catches up one whose kick
// found the sheet still busy with the transform (on the Windows runner a page outlasts the kick). The event loop is
// sampled every 5 ms from the first call to the last formula done, as transform-pages.test.ts does: it is never
// held 200 ms, and every formula ends right. On a 200,000-row sheet the longest stretch was 31, 50 and 70 ms
// (170 ms once with 3, no transaction in it); this size keeps the case near a minute. The Windows runner's disk took
// 7 minutes at it (3 formulas: written in 131 s, followed in 288 s, the loop held 128 ms): there it runs 10,000
// rows, in slices of the same size.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { undoKit } from './run-undo-kit'
import { heldText, loopWatch } from './bulk-wal-kit'
import { sqliteWriteProbe, transactionLine } from './sqlite-write-probe'
const { db, uid, ok, done, idle, sheet, cells } = undoKit('transform-formula-follow')
const { startFormulaColumn } = await import('../../server/src/services/formula-column')
const { startDerivedFollow } = await import('../../server/src/services/derived-follow')
const { startAutorunLoop } = await import('../../server/src/services/autorun-loop')
const { transformColumn } = await import('../../server/src/services/column-transform')
const { checkpointAsked, closeWalCheckpointer, walCheckpointerIdle } =
  await import('../../server/src/lib/wal-checkpointer')
startDerivedFollow()
startAutorunLoop()
console.error = () => {}
const probe = sqliteWriteProbe(db, process.env.DB_PATH!, checkpointAsked)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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
    assert.equal(queued.get(uid), 0, 'a formula never followed')
    const outs = cells(sid, 'Out')
    assert.deepEqual(outs, Array.from({ length: N }, (_, i) => `P${i}`), 'Out written')
    for (let k = 0; k < formulas; k++) {
      assert.deepEqual(cells(sid, `F${k}`), outs.map(o => `${o}-${k}`), `F${k} follows`)
    }
    assert.ok(watched.ownMs < LOOP_MS, `the event loop was held ${watched.ownMs.toFixed(0)} ms by this thread`)
  })
}

await closeWalCheckpointer()
done()
