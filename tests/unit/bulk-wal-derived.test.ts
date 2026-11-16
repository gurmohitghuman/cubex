// The derived columns' background bulk writers, each measured (bulk-wal-kit.ts): a clean column filled
// (services/derived-fill.ts) and the same column following its source once every source cell was written again
// (services/derived-follow.ts, tick after tick until its queue is empty). Rows with random ids and a 300-character
// cell, each checkpoint on the worker held 300 ms: the event loop is never held 200 ms, no checkpoint's sync runs
// on the API thread, the WAL stays under journal_size_limit, SQLite's own checkpoint is back on afterwards, and
// every cell ends cleaned.
import assert from 'node:assert/strict'
import { undoKit } from './run-undo-kit'
import { bulkWalKit } from './bulk-wal-kit'
const { db, uid, ok, done, idle, sheet, cells } = undoKit('bulk-wal-derived')
const { startCleanColumn } = await import('../../server/src/services/clean-column')
const { waitForCleanFill } = await import('../../server/src/services/clean-fill')
const { cleanFollowTick } = await import('../../server/src/services/clean-follow')
const { markAutorunInputs } = await import('../../server/src/lib/autorun-mark')
const { entryFor } = await import('../../server/src/services/autorun-entry')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}
const { measure } = bulkWalKit()

const N = 20_000
const queued = db.prepare('SELECT COUNT(*) FROM autorun_pending WHERE autorun_id = ?').pluck()

await ok('a clean column filled, then following its source: the WAL copied back on the worker', async () => {
  const sid = sheet(Array.from({ length: N }, (_, i) => ({ Name: `  n${i}  `, P: `${i}:${'p'.repeat(300)}` })),
    ['Name', 'P'])
  let filled: { fill_status: string; filled_rows: number } | undefined
  await measure('the clean column\'s fill', async () => {
    const started = await startCleanColumn(uid, sid, { source: 'Name', cleaner: 'trim' })
    assert.ok('ok' in started, JSON.stringify(started))
    filled = await waitForCleanFill(started.ok.id, 120_000)
    await idle(sid)
  }, { pastAuto: true })
  assert.equal(filled?.fill_status, 'done', JSON.stringify(filled))
  assert.equal(filled?.filled_rows, N)
  const want = (k: string) => Array.from({ length: N }, (_, i) => `${k}${i}`)
  assert.deepEqual(cells(sid, 'Name (clean)'), want('n'), 'every cell cleaned')

  // Every source cell written again, and queued for the column as an edit would.
  db.transaction(() => {
    db.prepare(`UPDATE rows SET data = json_set(data, '$.Name', ' m' || row_index || ' ') WHERE sheet_id = ?`)
      .run(sid)
    markAutorunInputs(sid, uid, ['Name'], { indexes: Array.from({ length: N }, (_, i) => i) })
  }).immediate()
  const id = entryFor(sid, uid, 'Name (clean)')!.id
  assert.equal(queued.get(id), N, 'every row queued')
  await measure('the clean column following its source', async () => {
    // A tick stops after CLEAN_FOLLOW_TICK_MS; the next one goes on, as the follow's kick would.
    for (const end = Date.now() + 120_000; (queued.get(id) as number) > 0 && Date.now() < end;) {
      await cleanFollowTick(entryFor(sid, uid, 'Name (clean)')!)
      await new Promise(r => setTimeout(r, 5))
    }
  }, { pastAuto: true })
  assert.equal(queued.get(id), 0, 'the queue is empty')
  assert.deepEqual(cells(sid, 'Name (clean)'), want('m'), 'every cell follows its source')
})

await closeWalCheckpointer()
done()
