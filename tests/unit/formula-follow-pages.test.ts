// A formula's follow after a big write (services/derived-follow.ts): 25,000 rows with random ids and a 300-character
// cell, 3 formula columns reading them, every source cell written again and queued as an undo of a run's column
// does, then the three following at once, tick after tick, as their kicks would. Measured with each checkpoint on the
// worker held 300 ms (bulk-wal-kit.ts): the longest follow transaction stays under 100 ms; a queued slice writes about
// DERIVED_QUEUED_SLICE_FRAMES pages (sized by what the last one wrote, derived-write.ts queuedRowsAfter), never half
// as many again; no two slices of the three are written in one turn of the event loop (lib/slice-turn.ts), so this
// thread never holds it 100 ms on the CPU in one stretch (loop-watch.ts); and every cell follows.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { undoKit } from './run-undo-kit'
import { bulkWalKit } from './bulk-wal-kit'
import { transactionLine } from './sqlite-write-probe'
const { db, uid, ok, done, sheet, cells } = undoKit('formula-follow-pages')
const { startFormulaColumn } = await import('../../server/src/services/formula-column')
const { waitForDerivedFill } = await import('../../server/src/services/derived-fill')
const { formulaKind } = await import('../../server/src/services/formula-kind')
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
const FOLLOW_TRANSACTION_MS = 100
const FOLLOW_LOOP_MS = 100
const SLICE_FRAMES_MAX = DERIVED_QUEUED_SLICE_FRAMES * 1.5
const FORMULAS: Record<string, [string, (name: string, p: string) => string]> = {
  Upper: ['{{Name}}.trim().toUpperCase()', n => n.trim().toUpperCase()],
  Size: ['{{Name}}.trim().length > 5 ? "long" : "short"', n => (n.trim().length > 5 ? 'long' : 'short')],
  Tag: ['{{Name}}.trim() + "-" + {{P}}.slice(0, 8)', (n, p) => `${n.trim()}-${p.slice(0, 8)}`],
}
const queued = db.prepare('SELECT COUNT(*) FROM autorun_pending WHERE autorun_id = ?').pluck()

// How long each slice's formula took to work its rows out (inside the slice's transaction).
const computeMs: number[] = []
const open = formulaKind.open
formulaKind.open = async (...a: Parameters<typeof open>) => {
  const p = await open(...a)
  if ('error' in p) return p
  const compute = p.compute
  return Object.assign(p, {
    compute: (rows: unknown[][], ms: number) => {
      const t = performance.now()
      try { return compute(rows, ms) } finally { computeMs.push(performance.now() - t) }
    },
  })
}

await ok('3 formulas following 25,000 rows written again: no follow transaction holds 100 ms', async () => {
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
  computeMs.length = 0

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
  const c = [...computeMs].sort((a, b) => b - a)
  console.log(`        the formulas worked rows out in ${computeMs.length} slices, longest ${c[0]?.toFixed(1)} ms`
    + ` (median ${c[Math.floor(c.length / 2)]?.toFixed(1)} ms)`)

  for (const e of entries) assert.equal(queued.get(e.id), 0, `${e.status_column}'s queue is empty`)
  const names = Array.from({ length: N }, (_, i) => ` m${i} `)
  for (const [column, [, want]] of Object.entries(FORMULAS)) {
    assert.deepEqual(cells(sid, column), names.map((n, i) => want(n, P(i))), `every ${column} cell follows`)
  }
  assert.ok(m.w.longestTransactionMs < FOLLOW_TRANSACTION_MS,
    `a follow transaction held ${m.w.longestTransactionMs.toFixed(0)} ms (most frames ${m.w.mostTransactionFrames})`)
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
