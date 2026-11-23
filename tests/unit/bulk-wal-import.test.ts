// A CSV import's bulk writers, each measured (bulk-wal-kit.ts): its rows added in flushes (services/csv-import.ts),
// each transaction of the import and the replace printed, a sheet's stored results deleted (lib/import-undo.ts: a
// replace, a sheet purged; answers of 16 KB each, which went 5,000 to a slice before, about 80 MB of WAL in one
// commit), an import cut short taken out again, and a replace end to end (the old rows to the trash, their results
// deleted, the new rows in). Rows with random ids, each checkpoint on the worker held 300 ms: the event loop is never
// held 200 ms, no checkpoint's sync runs on the API thread, the WAL stays under journal_size_limit, SQLite's own
// checkpoint is back on afterwards, and the rows and results end where they should.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import { bulkWalKit } from './bulk-wal-kit'
import { transactionLine, type TransactionRecord } from './sqlite-write-probe'
const { db, uid, ok, done, sheet, cells } = undoKit('bulk-wal-import')
const { importCsv } = await import('../../server/src/services/csv-import')
const { scanCsvText } = await import('../../server/src/lib/csv-import-parse')
const { purgeSheetResults, undoImport } = await import('../../server/src/lib/import-undo')
const { ENRICH_STORED_RAW_MAX_BYTES } = await import('../../server/src/lib/constants')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}
const { measure } = bulkWalKit()
// Each transaction of a measured job printed: a slice is one (lib/bulk-slices.ts).
const printed = (m: { records: TransactionRecord[] }) => {
  for (const r of m.records) console.log(`        ${transactionLine(r)}`)
}

const N = 20_000
const rowsOf = (sid: string) => db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ?').pluck().get(sid) as number
const csvOf = (n: number, tag: string) =>
  `Name,Answer,P\n${Array.from({ length: n }, (_, i) => `${tag}${i},a${i},${'p'.repeat(200)}`).join('\n')}\n`
const old = () => sheet(Array.from({ length: N }, (_, i) => ({ Name: `old${i}`, Answer: `o${i}`,
  P: 'q'.repeat(200) })), ['Name', 'Answer', 'P'])
// `n` stored HTTP results on `sid`, each answer at the most a result keeps (16 KB).
function results(sid: string, n: number) {
  const runId = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','completed','Answer')`).run(runId, sid, uid)
  const ins = db.prepare(`INSERT INTO http_results (id,run_id,user_id,row_index,response_data,status)
    VALUES (?,?,?,?,?,'completed')`)
  const raw = 'r'.repeat(ENRICH_STORED_RAW_MAX_BYTES)
  db.transaction(() => { for (let i = 0; i < n; i++) ins.run(uuid(), runId, uid, i, raw) }).immediate()
}
const stored = (sid: string) => db.prepare(`SELECT COUNT(*) FROM http_results WHERE run_id IN
  (SELECT id FROM http_runs WHERE sheet_id = ?)`).pluck().get(sid) as number

await ok('rows added in flushes: the WAL copied back on the worker', async () => {
  const sid = sheet([{ Name: 'first' }], ['Name'])
  const scanned = await scanCsvText(csvOf(N, 'new'))
  printed(await measure('the import', async () => {
    const out = await importCsv(sid, uid, scanned, false)
    assert.ok('ok' in out, JSON.stringify(out))
  }, { pastAuto: true }))
  assert.equal(rowsOf(sid), N + 1)
  assert.deepEqual([cells(sid, 'Name')[1], cells(sid, 'Name')[N]], ['new0', `new${N - 1}`])
})

await ok('16 KB answers deleted, RESULTS_SLICE_ROWS a slice: the WAL stays under journal_size_limit', async () => {
  const sid = old()
  results(sid, 4_000)
  await measure('the results deleted', () => purgeSheetResults(sid, uid), { pause: true })
  assert.equal(stored(sid), 0)
  assert.equal(rowsOf(sid), N, 'the rows stay')
})

await ok('an import cut short, taken out again: the WAL copied back on the worker', async () => {
  const sid = sheet([{ Name: 'kept' }], ['Name'])
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 1; i <= N; i++) ins.run(uuid(), sid, uid, i, JSON.stringify({ Name: `in${i}`, P: 'p'.repeat(200) }))
  }).immediate()
  const job = { sheet_id: sid, user_id: uid, is_replace: 0, first_row: 1, end_row: N + 1, columns: '["Name"]' }
  db.prepare(`INSERT INTO import_jobs (sheet_id,user_id,is_replace,first_row,end_row,columns)
    VALUES (?,?,0,?,?,?)`).run(sid, uid, job.first_row, job.end_row, job.columns)
  await measure('the import taken out', () => undoImport(job), { pastAuto: true })
  assert.deepEqual(cells(sid, 'Name'), ['kept'])
  assert.equal(db.prepare('SELECT COUNT(*) FROM import_jobs WHERE sheet_id = ?').pluck().get(sid), 0)
})

await ok('a replace end to end (old rows to the trash, their results deleted): the WAL copied back on the worker',
  async () => {
    const sid = old()
    results(sid, 2_000)
    const scanned = await scanCsvText(csvOf(N, 'new'))
    printed(await measure('the replace', async () => {
      const out = await importCsv(sid, uid, scanned, true)
      assert.ok('ok' in out, JSON.stringify(out))
    }, { pause: true }))
    assert.equal(rowsOf(sid), N)
    assert.deepEqual([cells(sid, 'Name')[0], cells(sid, 'Name')[N - 1]], ['new0', `new${N - 1}`])
    assert.equal(stored(sid), 0)
  })

await closeWalCheckpointer()
done()
