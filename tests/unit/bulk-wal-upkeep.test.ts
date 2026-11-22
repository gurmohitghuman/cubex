// The background upkeep's bulk writers, each measured (bulk-wal-kit.ts): list results added as rows
// (services/enrich-list-drain.ts, round after round until none are pending), a column rename rewriting twenty
// thousand runs (run-config-rewrite.ts), the change log's old lines pruned (sheet-history.ts), and an auto-run's
// queue of rows that are gone dropped as it picks (autorun-pick.ts). Each checkpoint on the worker held 300 ms:
// the event loop is never held 200 ms, no checkpoint's sync runs on the API thread, the WAL stays under
// journal_size_limit, SQLite's own checkpoint is back on afterwards, and every row ends where it should. Also: a
// drain round with nothing to add takes no write lock (it runs every 5 s, and waited behind every other writer).
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import { bulkWalKit } from './bulk-wal-kit'
import type { CandidatePlan } from '../../server/src/lib/autorun-rules'
const { db, uid, ok, done, idle, sheet } = undoKit('bulk-wal-upkeep')
const { drainListItems } = await import('../../server/src/services/enrich-list-drain')
const { renameSheetColumn } = await import('../../server/src/services/column-rename')
const { pruneChangeLog } = await import('../../server/src/services/sheet-history')
const { pickRows } = await import('../../server/src/services/autorun-pick')
const { loadEntry } = await import('../../server/src/services/autorun-entry')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}
const { measure } = bulkWalKit()

const count = (sql: string, ...params: unknown[]) => db.prepare(sql).pluck().get(...params) as number
const range = (n: number) => Array.from({ length: n }, (_, i) => i)

await ok('a drain round with nothing to add takes no write lock', async () => {
  const other = new Database(process.env.DB_PATH!)
  other.exec('BEGIN IMMEDIATE')
  try {
    const t0 = performance.now()
    await drainListItems()
    const ms = performance.now() - t0
    console.log(`      the round took ${ms.toFixed(0)} ms`)
    assert.ok(ms < 1_000, `the round waited ${ms.toFixed(0)} ms for another connection's write`)
  } finally {
    other.exec('ROLLBACK')
    other.close()
  }
})

await ok('list results added as rows: the WAL copied back on the worker', async () => {
  const SOURCES = 250, ITEMS = 160
  const src = sheet(range(SOURCES).map(i => ({ Company: `Co${i}`, People: `➕ Adding ${ITEMS} rows…` })),
    ['Company', 'People'])
  const dest = sheet([], ['Company', 'Name'])
  const list = {
    destSheetId: dest, itemsPath: '$.output.people', provider: 'quickenrich', maxItems: ITEMS,
    fields: [{ path: '$.name', columnName: 'Name' }], copy: [{ id: 'c1', from: 'Company', to: 'Company' }],
    dedupe: null,
  }
  const runId = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name,
    dest_sheet_id) VALUES (?, ?, ?, ?, 'completed', 0, 'People', ?)`)
    .run(runId, src, uid, JSON.stringify({ requestConfig: {}, responseMapping: [], enrichment: { v: 1, list } }), dest)
  const rowIds = db.prepare('SELECT id FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(src) as string[]
  const journal = db.prepare(`INSERT INTO enrichment_list_items (id, user_id, run_id, source_sheet_id, source_row_id,
    dest_sheet_id, items_json, item_count) VALUES (?,?,?,?,?,?,?,?)`)
  db.transaction(() => rowIds.forEach((rowId, s) => journal.run(uuid(), uid, runId, src, rowId, dest, JSON.stringify({
    items: range(ITEMS).map(k => ({ name: `P${s}-${k} ${'n'.repeat(150)}` })), copy: { c1: `Co${s}` } }), ITEMS)))
    .immediate()
  const pending = () => count(`SELECT COUNT(*) FROM enrichment_list_items WHERE status = 'pending'`)
  await measure('list results added as rows', async () => {
    for (const end = Date.now() + 120_000; pending() > 0 && Date.now() < end;) await drainListItems()
  }, { pastAuto: true })
  assert.equal(pending(), 0, 'every journal row added')
  assert.equal(count('SELECT COUNT(*) FROM rows WHERE sheet_id = ?', dest), SOURCES * ITEMS)
  assert.equal(count(`SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND json_extract(data, '$.People') = ?`, src,
    `✅ ${ITEMS} rows added`), SOURCES, 'each source cell says what was added')
  assert.equal(count(`SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND json_extract(data, '$.Name') LIKE 'P%'
    AND json_extract(data, '$.Company') LIKE 'Co%'`, dest), SOURCES * ITEMS, 'each row has its cells')
})

await ok('a rename rewriting twenty thousand runs: the WAL copied back on the worker', async () => {
  const RUNS = 20_000
  const sid = sheet([{ Name: 'a', Out: 'x' }], ['Name', 'Out'])
  const config = JSON.stringify({
    requestConfig: { url: 'https://x.test/{{Out}}', body: `{"pad":"${'b'.repeat(1500)}"}` },
    responseMapping: [{ path: '$.a', columnName: 'Out' }],
  })
  const ins = db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name)
    VALUES (?,?,?,?, 'completed', 'Out')`)
  db.transaction(() => range(RUNS).forEach(() => ins.run(uuid(), sid, uid, config))).immediate()
  await measure('the runs rewritten', async () => {
    const out = await renameSheetColumn(sid, uid, 'Out', 'Out2')
    assert.ok('ok' in out, JSON.stringify(out))
    await idle(sid)
  }, { pastAuto: true })
  assert.equal(count(`SELECT COUNT(*) FROM http_runs WHERE sheet_id = ? AND master_column_name = 'Out2'
    AND json_extract(config, '$.responseMapping[0].columnName') = 'Out2'
    AND json_extract(config, '$.requestConfig.url') = 'https://x.test/{{Out2}}'`, sid), RUNS, 'every run rewritten')
  assert.equal(count('SELECT COUNT(*) FROM run_config_rewrites WHERE sheet_id = ?', sid), 0, 'nothing left to do')
})

await ok('the change log\'s old lines pruned: the WAL copied back on the worker', async () => {
  const sid = sheet([{ Name: 'a' }], ['Name'])
  const ins = db.prepare(`INSERT INTO sheet_changes (user_id, sheet_id, at, via, action, summary, detail)
    VALUES (?, ?, datetime('now', ?), 'app', 'cells_edited', 'Edited a cell', ?)`)
  const detail = JSON.stringify({ before: 'b'.repeat(100), after: 'a'.repeat(100) })
  db.transaction(() => {
    for (const i of range(60_000)) ins.run(uid, sid, `-${100 + (i % 50)} days`, detail)
    range(1_000).forEach(() => ins.run(uid, sid, '-1 days', detail))
  }).immediate()
  await measure('the old lines pruned', () => pruneChangeLog(), { pastAuto: true })
  assert.equal(count('SELECT COUNT(*) FROM sheet_changes WHERE sheet_id = ?', sid), 1_000, 'recent lines stay')
})

await ok('an auto-run\'s queue of rows that are gone, dropped as it picks: the WAL copied back on the worker',
  async () => {
    const sid = sheet([{ Name: 'a' }], ['Name', 'Status'])
    const entry = uuid()
    db.prepare(`INSERT INTO autorun_columns (id,user_id,sheet_id,status_column,kind,input_columns,watermark_row_index)
      VALUES (?,?,?,'Status','http','["Name"]',0)`).run(entry, uid, sid)
    // Queued in random order (row ids are random): each page's delete reaches pages all over the table.
    const ins = db.prepare('INSERT INTO autorun_pending (autorun_id, user_id, row_id) VALUES (?,?,?)')
    db.transaction(() => range(60_000).forEach(() => ins.run(entry, uid, uuid()))).immediate()
    let picked: Awaited<ReturnType<typeof pickRows>> | undefined
    await measure('the queue dropped', async () => {
      picked = await pickRows(loadEntry(entry)!, {} as CandidatePlan, 100)
    }, { pastAuto: true })
    assert.deepEqual(picked?.rows, [], 'nothing to run')
    assert.equal(count('SELECT COUNT(*) FROM autorun_pending WHERE autorun_id = ?', entry), 0, 'the queue is empty')
  })

await closeWalCheckpointer()
done()
