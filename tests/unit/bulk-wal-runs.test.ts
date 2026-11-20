// The runs' background bulk writers, each measured (bulk-wal-kit.ts): a run's ⏳ clear with three formulas reading
// its columns (lib/placeholder-cells.ts, its slices checkpointed, a span each for them), and undo journals dropped
// (services/run-undo-prune.ts: an undone journal's rows, and an emptied sheet's journals). Rows with random ids,
// each checkpoint on the worker held 300 ms: the event loop is never held 200 ms, no checkpoint's sync runs on the
// API thread, the WAL stays under journal_size_limit, SQLite's own checkpoint is back on afterwards, and every
// cell and journal row ends where it should. Undoing a run is measured in run-undo-slices.test.ts.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import { bulkWalKit } from './bulk-wal-kit'
const { db, uid, ok, done, idle, sheet } = undoKit('bulk-wal-runs')
const { clearProcessingPlaceholders, PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
const { startFormulaColumn } = await import('../../server/src/services/formula-column')
const { pruneRunUndos, dropSheetUndos } = await import('../../server/src/services/run-undo-prune')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}
const { measure } = bulkWalKit()

// Enough rows for the clear's own writes to reach the WAL's pause (the formulas' spans write little).
const N = 100_000
const held = db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND instr(data, ?) > 0').pluck()

await ok('a run\'s clear, three formulas reading its column: the WAL copied back on the worker', async () => {
  const sid = sheet(Array.from({ length: N }, (_, i) => ({ Name: `n${i}`, Status: PLACEHOLDER, Answer: PLACEHOLDER,
    P: `${i}:${'p'.repeat(200)}` })), ['Name', 'Status', 'Answer'])
  for (const k of [1, 2, 3]) {
    assert.ok('ok' in await startFormulaColumn(uid, sid, { column: `F${k}`, formula: `{{Answer}} + "${k}"` }))
    await idle(sid)
  }
  await measure('the clear', () => clearProcessingPlaceholders(sid, uid, ['Status', 'Answer']), { pause: true })
  assert.equal(held.get(sid, PLACEHOLDER), 0, 'every ⏳ cleared')
  const told = db.prepare(`SELECT SUM(json_array_length(s.rowids)) FROM derived_span_marks m
    JOIN derived_spans s ON s.id = m.span_id WHERE s.sheet_id = ?`).pluck()
  assert.equal(told.get(sid), 3 * N, 'every row told each formula')
})

// A journal of `n` rows (about 600 bytes of old values each), kept for a run on `sid` in `state`.
function journal(sid: string, n: number, state: 'kept' | 'undone'): number {
  const id = db.prepare(`INSERT INTO run_undos (user_id,sheet_id,run_kind,run_id,columns,row_count,state)
    VALUES (?,?,'http',?,'["Out"]',?,?)`).run(uid, sid, uuid(), n, state).lastInsertRowid as number
  const ins = db.prepare('INSERT INTO run_undo_rows (undo_id,row_id,ref,stamp,cells) VALUES (?,?,?,NULL,?)')
  db.transaction(() => {
    for (let i = 1; i <= n; i++) ins.run(id, i, uuid().slice(0, 8), JSON.stringify([[0, `"${'o'.repeat(600)}"`, i]]))
  }).immediate()
  return id
}
const kept = (id: number) => db.prepare('SELECT COUNT(*) FROM run_undo_rows WHERE undo_id = ?').pluck().get(id)

await ok('undo journals dropped (an undone one\'s rows; an emptied sheet\'s): the WAL copied back on the worker',
  async () => {
    const sid = sheet([{ Out: 'x' }], ['Out'])
    const undone = journal(sid, 90_000, 'undone')
    await measure('an undone journal\'s rows', () => pruneRunUndos(), { pause: true })
    assert.equal(kept(undone), 0)
    assert.ok(db.prepare('SELECT 1 FROM run_undos WHERE id = ?').get(undone), 'its counts stay')
    const gone = sheet([{ Out: 'x' }], ['Out'])
    const ids = [journal(gone, 45_000, 'kept'), journal(gone, 45_000, 'kept')]
    // Each journal a job of its own, its WAL copied back after it: neither reaches the pause.
    await measure('an emptied sheet\'s journals', () => dropSheetUndos(gone))
    assert.deepEqual(ids.map(kept), [0, 0])
    assert.equal(db.prepare('SELECT COUNT(*) FROM run_undos WHERE sheet_id = ?').pluck().get(gone), 0)
  })

await closeWalCheckpointer()
done()
