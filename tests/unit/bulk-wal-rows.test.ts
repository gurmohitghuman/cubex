// The writers that walk a sheet's rows in storage order on the server's thread (lib/row-order.ts), and a run's undo
// with no column reading it (services/run-undo.ts), each measured (bulk-wal-kit.ts): a run's ⏳ seeded with its undo
// journal, its cells cleared with no column reading them, a column's key copied (a rename's first half) and
// stripped (a delete). Rows with random ids and about 600 bytes each, so each job takes the WAL past SQLite's own
// mark, where a commit with its checkpoint on would copy the WAL back inside it. Each checkpoint on the worker held
// 300 ms: the event loop is never held 200 ms, no checkpoint's sync runs on the API thread, the WAL stays under
// journal_size_limit, SQLite's own checkpoint is back on afterwards, and every cell ends where it should. The rule
// seed, enrichment's seed and auto-run's keep-unswept go through the same walk.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import { bulkWalKit } from './bulk-wal-kit'
const { db, uid, ok, done, idle, sheet, cells, run, journal } = undoKit('bulk-wal-rows')
const { seedProcessingPlaceholders, clearProcessingPlaceholders, PLACEHOLDER } =
  await import('../../server/src/lib/placeholder-cells')
const { copyColumnKey, purgeColumnKey, recordPurge } = await import('../../server/src/lib/column-purge')
const { undoRun } = await import('../../server/src/services/run-undo')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}
const { measure } = bulkWalKit()

const N = 20_000
const big = () => sheet(Array.from({ length: N }, (_, i) => ({ Name: `n${i}`, Status: `s${i}`, Answer: `a${i}`,
  P: `${i}:${'p'.repeat(500)}` })), ['Name', 'Status', 'Answer', 'P'])
const held = db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND instr(data, ?) > 0').pluck()
const ends = (sid: string, column: string) => [cells(sid, column)[0], cells(sid, column)[N - 1]]

await ok('a run seeded, then its cells cleared with none reading them: the WAL copied back on the worker',
  async () => {
    const sid = big()
    const id = uuid()
    db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
      VALUES (?,?,?,'{}','running','Status')`).run(id, sid, uid)
    const r = { kind: 'http' as const, id }
    await measure('the seed', () => seedProcessingPlaceholders({ run: r, sheetId: sid, userId: uid,
      columns: ['Status', 'Answer'], targets: null, lastRow: N - 1, live: () => true }), { pastAuto: true })
    assert.equal(held.get(sid, PLACEHOLDER), N, 'every row seeded')
    assert.equal(db.prepare('SELECT COUNT(*) FROM run_undo_rows').pluck().get(), N, 'every row journaled')
    // A run that ended before it wrote a row: each cell gets back what the journal kept.
    await measure('the clear', () => clearProcessingPlaceholders(sid, uid, ['Status', 'Answer'], undefined, r),
      { pastAuto: true })
    assert.equal(held.get(sid, PLACEHOLDER), 0, 'every ⏳ cleared')
    assert.deepEqual([...ends(sid, 'Status'), ...ends(sid, 'Answer')], ['s0', `s${N - 1}`, 'a0', `a${N - 1}`])
  })

await ok('a column\'s key copied, then stripped: the WAL copied back on the worker', async () => {
  const sid = big()
  await measure('the key copied', () => copyColumnKey(sid, uid, 'Answer', 'Reply'), { pastAuto: true })
  assert.deepEqual(ends(sid, 'Reply'), ['a0', `a${N - 1}`])
  recordPurge(sid, uid, 'Answer')
  await measure('the key stripped', () => purgeColumnKey(sid, uid, 'Answer'), { pastAuto: true })
  assert.equal(db.prepare(`SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND json_type(data, '$.Answer') IS NOT NULL`)
    .pluck().get(sid), 0)
  assert.deepEqual(ends(sid, 'Reply'), ['a0', `a${N - 1}`])
})

await ok('a run undone, no column reading it: the WAL copied back on the worker', async () => {
  const sid = big()
  const runId = await run(sid, 'http', ['Answer'],
    Object.fromEntries(Array.from({ length: N }, (_, i) => [i, [`new ${i}`]])))
  assert.deepEqual(ends(sid, 'Answer'), ['new 0', `new ${N - 1}`])
  await measure('the undo', async () => {
    const out = await undoRun(uid, 'http', runId)
    assert.ok('ok' in out, JSON.stringify(out))
    await idle(sid)
  }, { pastAuto: true })
  assert.equal(journal('http', runId)!.state, 'undone')
  assert.deepEqual(ends(sid, 'Answer'), ['a0', `a${N - 1}`])
})

await closeWalCheckpointer()
done()
