// A physical sort's bulk writers, measured as one sort (bulk-wal-kit.ts): auto-run's unswept rows kept by id
// (lib/autorun-mark.ts, through lib/row-order.ts), the plan journaled and the rows moved (lib/sort-plan.ts), and
// stored results moved with their rows (lib/sort-results.ts; answers of 16 KB each, RESULTS_SLICE_ROWS a slice: at
// 5,000 a slice, one moved about 80 MB into the WAL). Rows with random ids, each checkpoint on the worker held
// 300 ms: the event loop is never held 200 ms, no checkpoint's sync runs on the API thread, the WAL stays under
// journal_size_limit, SQLite's own checkpoint is back on afterwards, and every row, result and queued row ends
// where it should.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import { bulkWalKit } from './bulk-wal-kit'
const { db, uid, ok, done, sheet, cells } = undoKit('bulk-wal-sort')
const { physicalSortSheet } = await import('../../server/src/services/sheet-sort')
const { ENRICH_STORED_RAW_MAX_BYTES } = await import('../../server/src/lib/constants')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}
const { measure } = bulkWalKit()

const N = 20_000, RESULTS = 3_000, FENCE = N / 2
const name = (i: number) => `n${String(i).padStart(6, '0')}`

await ok('a sort with 16 KB answers and unswept rows: the WAL copied back on the worker', async () => {
  const sid = sheet(Array.from({ length: N }, (_, i) => ({ Name: name(i), P: `${i}:${'p'.repeat(300)}` })),
    ['Name', 'Status', 'P'])
  const runId = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','completed','Status')`).run(runId, sid, uid)
  const ins = db.prepare(`INSERT INTO http_results (id,run_id,user_id,row_index,response_data,status)
    VALUES (?,?,?,?,?,'completed')`)
  db.transaction(() => {
    for (let i = 0; i < RESULTS; i++) ins.run(uuid(), runId, uid, i, `${i}:${'r'.repeat(ENRICH_STORED_RAW_MAX_BYTES)}`)
  }).immediate()
  // An auto-run fenced halfway: the rows above it (Status empty) haven't been looked at yet.
  const entry = uuid()
  db.prepare(`INSERT INTO autorun_columns (id,user_id,sheet_id,status_column,kind,input_columns,watermark_row_index)
    VALUES (?,?,?,'Status','http','["Name"]',?)`).run(entry, uid, sid, FENCE)

  await measure('the sort', async () => {
    const out = await physicalSortSheet(sid, uid, 'Name', 'desc')
    assert.ok('ok' in out && out.rowsReordered === N, JSON.stringify(out))
  }, { pause: true })

  const names = cells(sid, 'Name')
  assert.deepEqual([names[0], names[N - 1]], [name(N - 1), name(0)])
  // Each result follows its row: the one stored for old row i now points at N - 1 - i.
  const moved = db.prepare(`SELECT row_index, substr(response_data, 1, instr(response_data, ':') - 1) AS was
    FROM http_results WHERE run_id = ?`).all(runId) as Array<{ row_index: number; was: string }>
  assert.equal(moved.length, RESULTS)
  assert.deepEqual(moved.filter(r => r.row_index !== N - 1 - Number(r.was)), [], 'every result at its row')
  const queued = db.prepare(`SELECT COUNT(*) FROM autorun_pending p JOIN rows r ON r.id = p.row_id
    WHERE p.autorun_id = ? AND r.row_index < ?`).pluck()
  // Rows FENCE + 1 … N - 1 were unswept; sorted descending they sit at 0 … N - 2 - FENCE.
  assert.equal(queued.get(entry, N - 1 - FENCE), N - 1 - FENCE, 'every unswept row kept by id')
})

await closeWalCheckpointer()
done()
