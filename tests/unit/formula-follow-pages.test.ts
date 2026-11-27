// A formula's follow after a big write (services/derived-follow.ts): 25,000 rows with random ids and a 300-character
// cell, 3 formula columns reading them, every source cell written again and queued as an undo of a run's column does,
// then the three following at once, tick after tick, as their kicks would. Measured with each checkpoint on the worker
// held 300 ms (bulk-wal-kit.ts): no follow transaction spends 100 ms on the CPU, this thread's time in it and the
// formula worker's for the rows it worked out there (this thread waits for that worker inside the transaction, off the
// CPU, and each slice's work is bounded by its own clock, derived-write.ts); its wall-clock time is printed, not
// bounded, as a busy machine stretches it. Waits off the CPU that a slice's code makes are checked as events instead:
// this thread waits on another (Atomics.wait) only for the formula's answer, and no such wait runs out its time (the
// worker's wake lost; a worker pausing off the CPU for less than the cap isn't bounded); where writers wait for a
// running checkpoint (Windows and Linux), none begins inside one (bulk-wal-kit.ts); where a server makes the -wal file
// its full size at start (Windows), so does this, and no follow write grows it (such a commit can wait on the OS). A
// queued slice writes about DERIVED_QUEUED_SLICE_FRAMES pages (sized by what the last one wrote, derived-write.ts
// queuedRowsAfter), never half as many again; no two slices of the three are written in one turn of the event loop
// (lib/slice-turn.ts), so this thread never holds it 100 ms on the CPU in one stretch (loop-watch.ts); and every cell
// follows.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { undoKit } from './run-undo-kit'
import { bulkWalKit } from './bulk-wal-kit'
import { sizeWalLikeAServer, transactionLine, walGrowth, type TransactionRecord } from './sqlite-write-probe'
const { db, uid, ok, done, sheet, cells } = undoKit('formula-follow-pages')
const walSized = sizeWalLikeAServer(db, process.env.DB_PATH!)
const { startFormulaColumn } = await import('../../server/src/services/formula-column')
const { waitForDerivedFill } = await import('../../server/src/services/derived-fill')
const { formulaKind } = await import('../../server/src/services/formula-kind')
const { formulaHost } = await import('../../server/src/lib/formula/host')
const { derivedFollowTick } = await import('../../server/src/services/derived-follow')
const { markAutorunInputs } = await import('../../server/src/lib/autorun-mark')
const { entryFor } = await import('../../server/src/services/autorun-entry')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
const { DERIVED_QUEUED_FIRST_ROWS, DERIVED_QUEUED_SLICE_FRAMES, DERIVED_QUEUED_SLICE_ROWS } =
  await import('../../server/src/lib/constants')
const { queuedRowsAfter } = await import('../../server/src/services/derived-write')
console.error = () => {}
const { measure } = bulkWalKit()

const N = 25_000
// A follow transaction's CPU time, both threads: 10 to 30 ms here, its wall-clock time up to 65 ms on an idle Mac
// and 140 ms with the CPU shared.
const FOLLOW_TRANSACTION_CPU_MS = 100
const FOLLOW_LOOP_MS = 100
const SLICE_FRAMES_MAX = DERIVED_QUEUED_SLICE_FRAMES * 1.5
const FORMULAS: Record<string, [string, (name: string, p: string) => string]> = {
  Upper: ['{{Name}}.trim().toUpperCase()', n => n.trim().toUpperCase()],
  Size: ['{{Name}}.trim().length > 5 ? "long" : "short"', n => (n.trim().length > 5 ? 'long' : 'short')],
  Tag: ['{{Name}}.trim() + "-" + {{P}}.slice(0, 8)', (n, p) => `${n.trim()}-${p.slice(0, 8)}`],
}
const queued = db.prepare('SELECT COUNT(*) FROM autorun_pending WHERE autorun_id = ?').pluck()

// Each request to the formula worker (lib/formula/host.ts, synchronous: this thread waits off the CPU for the answer):
// what it asked (run: a slice's rows worked out, inside its transaction; open: the formula made ready, as a tick
// starts), when it began, how long it took, and the CPU time other threads spent while it ran: the worker's (whatever
// else ran in those few ms counts too: the safe side).
const requests: Array<{ op: string; at: number; ms: number; workerCpuMs: number; rows: number }> = []
const cpuOf = (u: NodeJS.CpuUsage) => (u.user + u.system) / 1000
let inRequest = false
const request = formulaHost.request.bind(formulaHost)
formulaHost.request = (...a: Parameters<typeof request>) => {
  const at = performance.now(), all = process.cpuUsage(), own = process.threadCpuUsage()
  inRequest = true
  try { return request(...a) } finally {
    inRequest = false
    const workerCpuMs = Math.max(0, cpuOf(process.cpuUsage(all)) - cpuOf(process.threadCpuUsage(own)))
    requests.push({ op: a[0].op, at, ms: performance.now() - at, workerCpuMs,
      rows: a[0].op === 'run' ? a[0].rows.length : 0 })
  }
}
// This thread's synchronous waits on another thread (Atomics.wait) outside a formula request: a follow waits only for
// the worker's answer; another wait would hold the thread off the CPU, which its CPU time doesn't show. Inside one, a
// wait that runs out its time (timed-out) is the worker's wake lost (the host then sees the answer only at its cap,
// 220 ms later, both threads idle): none should.
let otherWaits = 0
let timedOutWaits = 0
const atomicsWait = Atomics.wait
Atomics.wait = ((...args: Parameters<typeof Atomics.wait>) => {
  if (!inRequest) otherWaits++
  const out = atomicsWait(...args)
  if (inRequest && out === 'timed-out') timedOutWaits++
  return out
}) as typeof Atomics.wait
// A transaction's CPU time: this thread's, and the formula worker's for the requests begun in it.
const inside = (r: TransactionRecord) => requests.filter(c => c.at >= r.at && c.at < r.at + r.ms)
const cpuIn = (r: TransactionRecord) => r.cpuMs + inside(r).reduce((s, c) => s + c.workerCpuMs, 0)

await ok('3 formulas following 25,000 rows written again: no follow transaction is 100 ms on the CPU', async () => {
  const P = (i: number) => `${i}:${'p'.repeat(300)}`
  const sid = sheet(Array.from({ length: N }, (_, i) => ({ Name: ` n${i} `, P: P(i) })), ['Name', 'P'])
  for (const [column, [formula]] of Object.entries(FORMULAS)) {
    const started = await startFormulaColumn(uid, sid, { column, formula })
    assert.ok('ok' in started, JSON.stringify(started))
    const filled = await waitForDerivedFill(formulaKind, started.ok.id, 120_000)
    assert.equal(filled?.fill_status, 'done', JSON.stringify(filled))
  }
  // Every source cell written again, and queued for the three columns as an undo would.
  db.transaction(() => {
    db.prepare(`UPDATE rows SET data = json_set(data, '$.Name', ' m' || row_index || ' ') WHERE sheet_id = ?`)
      .run(sid)
    markAutorunInputs(sid, uid, ['Name'], { indexes: Array.from({ length: N }, (_, i) => i) })
  }).immediate()
  const entries = Object.keys(FORMULAS).map(c => entryFor(sid, uid, c)!)
  for (const e of entries) assert.equal(queued.get(e.id), N, `every row queued for ${e.status_column}`)
  requests.length = 0
  otherWaits = 0
  timedOutWaits = 0

  const grown = walGrowth(process.env.DB_PATH!, walSized)
  const m = await measure('3 formulas following 25,000 rows', async () => {
    await Promise.all(entries.map(async e => {
      // A tick stops after CLEAN_FOLLOW_TICK_MS; the next one goes on, as the follow's kick would.
      for (const end = Date.now() + 300_000; (queued.get(e.id) as number) > 0 && Date.now() < end;) {
        await derivedFollowTick(entryFor(sid, uid, e.status_column)!)
        await new Promise(r => setTimeout(r, 5))
      }
    }))
  }, { pastAuto: true, turns: true })
  const slowest = [...m.records].sort((a, b) => b.ms - a.ms).slice(0, 5)
  console.log(`        slowest transactions: ${slowest.map(transactionLine).join(' | ')}`)
  const busiest = [...m.records].sort((a, b) => cpuIn(b) - cpuIn(a)).slice(0, 3)
  console.log(`        most CPU time in one (the worker's too): ${busiest.map(r => `${cpuIn(r).toFixed(1)} ms in `
    + transactionLine(r)).join(' | ')}`)
  const runs = requests.filter(x => x.op === 'run')
  const c = runs.map(x => x.ms).sort((a, b) => b - a)
  console.log(`        the formulas worked rows out in ${c.length} slices, longest ${c[0]?.toFixed(1)} ms`
    + ` (median ${c[Math.floor(c.length / 2)]?.toFixed(1)} ms); ${requests.length - runs.length} other requests`)

  for (const e of entries) assert.equal(queued.get(e.id), 0, `${e.status_column}'s queue is empty`)
  const names = Array.from({ length: N }, (_, i) => ` m${i} `)
  for (const [column, [, want]] of Object.entries(FORMULAS)) {
    assert.deepEqual(cells(sid, column), names.map((n, i) => want(n, P(i))), `every ${column} cell follows`)
  }
  // The worker's time counts only where its requests are seen inside a follow transaction: every slice's is, and
  // they worked out every cell that followed (none seen would bound nothing: the request patched above unused).
  assert.deepEqual(runs.filter(x => !m.records.some(r => inside(r).includes(x))), [],
    'slices\' formula requests made outside a follow transaction')
  const asked = runs.reduce((s, x) => s + x.rows, 0)
  assert.ok(asked >= N * Object.keys(FORMULAS).length, `the formula requests seen asked for ${asked} rows`)
  const most = cpuIn(busiest[0])
  assert.ok(most < FOLLOW_TRANSACTION_CPU_MS, `a follow transaction was ${most.toFixed(0)} ms on the CPU `
    + `(${transactionLine(busiest[0])}; most frames ${m.w.mostTransactionFrames})`)
  assert.equal(otherWaits, 0, 'waits of this thread on another, outside a formula request')
  assert.equal(timedOutWaits, 0, 'waits for the formula worker that ran out their time (its wake lost)')
  assert.equal(grown(m.records), '', 'follow writes that grew the -wal file')
  assert.ok(m.w.mostTransactionFrames <= SLICE_FRAMES_MAX, `a follow slice wrote ${m.w.mostTransactionFrames} frames`)
  assert.ok(m.loopMs < FOLLOW_LOOP_MS, `this thread held the event loop ${m.loopMs.toFixed(0)} ms on the CPU`)
})

await ok('a queued slice sized by the pages the last one wrote, never past DERIVED_QUEUED_SLICE_ROWS', async () => {
  const first = DERIVED_QUEUED_FIRST_ROWS
  // Scattered rows (2 frames a row): as many as fit the frames.
  assert.equal(queuedRowsAfter(first, 1_000, 2_000), DERIVED_QUEUED_SLICE_FRAMES / 2)
  // Rows sharing pages: twice as many as last time at most, and never past the cap.
  assert.equal(queuedRowsAfter(first, first, 25), first * 2)
  assert.equal(queuedRowsAfter(1_000, 1_000, 50), DERIVED_QUEUED_SLICE_ROWS)
  assert.equal(queuedRowsAfter(4_000, 4_000, 0), DERIVED_QUEUED_SLICE_ROWS, 'nothing written')
  // Huge rows: 64 at least. None read: as it was.
  assert.equal(queuedRowsAfter(first, 100, 100_000), 64)
  assert.equal(queuedRowsAfter(first, 0, 0), first)
})

await closeWalCheckpointer()
done()
