// Dedupe's background bulk writers and the row-write keys' sweep, each measured (bulk-wal-kit.ts): duplicates
// removed (services/dedupe-remove.ts), auto-dedupe's waiting checks made (services/auto-dedupe-checks.ts, its
// slices under a deadline) and expired row-write keys deleted (lib/write-idempotency.ts). Rows with random ids,
// each checkpoint on the worker held 300 ms: the event loop is never held 200 ms, no checkpoint's sync runs on the
// API thread, the WAL stays under journal_size_limit, SQLite's own checkpoint is back on afterwards, and the rows
// that should go are gone.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import { bulkWalKit } from './bulk-wal-kit'
const { db, uid, ok, done, sheet } = undoKit('bulk-wal-dedupe')
const { removeDuplicates } = await import('../../server/src/services/dedupe-remove')
const { setAutoDedupe } = await import('../../server/src/services/auto-dedupe-setting')
const { maintainAutoDedupeSheet } = await import('../../server/src/services/auto-dedupe-index')
const { runChecks } = await import('../../server/src/services/auto-dedupe-checks')
const { autoDedupeOf, queueChecks } = await import('../../server/src/lib/auto-dedupe/store')
const { pruneWriteKeys } = await import('../../server/src/lib/write-idempotency')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}
const { measure } = bulkWalKit()

const N = 30_000
// N rows, each email twice (the second copy in the second half), with a 300-character Big cell.
const twice = () => sheet(Array.from({ length: N }, (_, i) => ({ Email: `u${i % (N / 2)}@x.co`,
  Big: `v${i}:${'x'.repeat(300)}` })), ['Email', 'Big'])
const rows = (sid: string) => db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ?').pluck().get(sid) as number

await ok('duplicates removed: the WAL copied back on the worker', async () => {
  const sid = twice()
  let out: Awaited<ReturnType<typeof removeDuplicates>> | null = null
  await measure('duplicates removed', async () => {
    out = await removeDuplicates(uid, sid, { columns: [{ column: 'Email', match: 'email' }] })
  }, { pause: true })
  assert.ok(out && 'ok' in out && out.ok.removed === N / 2, JSON.stringify(out))
  assert.equal(rows(sid), N / 2)
})

// The second half's checks queued, as a CSV import's are (auto-dedupe-import.ts), once the keys are built.
await ok('auto-dedupe\'s waiting checks: the WAL copied back on the worker', async () => {
  const sid = twice()
  assert.ok('ok' in setAutoDedupe(uid, sid, { column: 'Email', match: 'email', keep: 'oldest' }))
  assert.equal(await maintainAutoDedupeSheet(sid, uid, Date.now() + 60_000), 'ready')
  const ids = db.prepare('SELECT rowid FROM rows WHERE sheet_id = ? ORDER BY rowid').pluck().all(sid) as number[]
  queueChecks(autoDedupeOf(sid, uid)!.id, ids[N / 2], ids[N - 1])
  // Turning it on also started its background driver, which may make some of them: the rows left are asserted.
  await measure('auto-dedupe\'s checks', async () => {
    const r = await runChecks(sid, uid, { ownBusy: false, deadline: Date.now() + 120_000 })
    assert.ok(!r.left, JSON.stringify(r))
  }, { pause: true })
  assert.equal(rows(sid), N / 2)
})

// 4,500 appends' keys over a day old, each answer about 8 KB.
await ok('expired row-write keys deleted: the WAL copied back on the worker', async () => {
  const insert = db.prepare(`INSERT INTO data_operation_ledger (id, user_id, idempotency_key, operation_kind,
    request_hash, result_json, created_at) VALUES (?, ?, ?, 'rows_append', 'h', ?, datetime('now', '-30 hours'))`)
  const n = 4_500
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      insert.run(uuid(), uid, `old-${i}`, JSON.stringify({ ids: `${i}:${'r'.repeat(8_000)}` }))
    }
  }).immediate()
  let gone = 0
  await measure('expired keys deleted', async () => { gone = await pruneWriteKeys() }, { pause: true })
  assert.equal(gone, n)
})

await closeWalCheckpointer()
done()
