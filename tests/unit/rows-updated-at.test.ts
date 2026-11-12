// Over 200 lines: one check per kind of writer, each with its own small sheet; split they'd share the fixture.
// Every writer of a row's cells keeps rows.updated_at current, in the same
// statement (read_rows' updated_since reads it through migration 050's index).
// Each check puts updated_at in the past, runs a real writer of one kind
// through its service, and checks the rows it changed read now while the rows
// it left alone keep their time: a person's or agent's edit, new rows (append,
// CSV import), run placeholders seeded, "Only run if" marks, run results and
// the clear of leftover placeholders, a clean column's fill (the derived engine
// clean, formula and lookup columns share) and its cell writer emptying a cell,
// an answer field from stored answers, transform_column, a column rename and
// delete (keys rewritten; a delete that also drops dead run-input keys stamps
// only the rows holding the cell), rows restored from the trash (changed now,
// not at their old time) and a run undone. A sort only moves rows: it keeps
// every time. Auto-run's and an enrichment's seeding are in
// rows-updated-at-starts.test.ts (they need the job queue stubbed).
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
const { db, uid, ok, done, idle, sheet, run } = undoKit('rows-updated-at')
const { patchRowById, appendRows } = await import('../../server/src/services/rows-write')
const { batchUpdateRows } = await import('../../server/src/services/rows-batch-update')
const { importCsv } = await import('../../server/src/services/csv-import')
const { scanCsvText } = await import('../../server/src/lib/csv-import-parse')
const { seedProcessingPlaceholders, clearProcessingPlaceholders } =
  await import('../../server/src/lib/placeholder-cells')
const { seedPlaceholdersByRule } = await import('../../server/src/lib/placeholder-rule-seed')
const { writeRunCells } = await import('../../server/src/lib/run-cells-write')
const { startCleanColumn } = await import('../../server/src/services/clean-column')
const { waitForCleanFill } = await import('../../server/src/services/clean-fill')
const { runFieldJob } = await import('../../server/src/services/answer-field-fill')
const { transformColumn } = await import('../../server/src/services/column-transform')
const { renameSheetColumn } = await import('../../server/src/services/column-rename')
const { deleteSheetColumn } = await import('../../server/src/services/column-delete')
const { deleteRowsToTrash } = await import('../../server/src/services/trash-rows')
const { restoreRows } = await import('../../server/src/services/trash-restore')
const { undoRun } = await import('../../server/src/services/run-undo')
const { physicalSortSheet } = await import('../../server/src/services/sheet-sort')
const { checkRule } = await import('../../server/src/lib/run-condition')
const { writeDerivedCells, asDerivedRead } = await import('../../server/src/services/derived-write')
const { purgeColumnKey } = await import('../../server/src/lib/column-purge')
const { jsonPath } = await import('../../server/src/lib/sql-rows')

const PAST = '2000-01-01 00:00:00'
const past = (sid: string) => db.prepare('UPDATE rows SET updated_at = ? WHERE sheet_id = ?').run(PAST, sid)
// Row index → updated_at, and the server's time just before a writer ran.
const times = (sid: string) => Object.fromEntries((db.prepare(`SELECT row_index, updated_at FROM rows
  WHERE sheet_id = ? ORDER BY row_index`).all(sid) as Array<{ row_index: number; updated_at: string }>)
  .map(r => [r.row_index, r.updated_at]))
const clock = () => db.prepare("SELECT datetime('now')").pluck().get() as string
// The rows (by index) whose time moved to `since` or later; every other row must still read PAST.
function changed(sid: string, since: string): number[] {
  const out: number[] = []
  for (const [i, t] of Object.entries(times(sid))) {
    if (t >= since) out.push(Number(i))
    else assert.equal(t, PAST, `row ${i} reads ${t}: neither now nor left alone`)
  }
  return out
}
const ids = (sid: string) => db.prepare('SELECT id FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
  .all(sid) as string[]

await ok('a person or agent editing cells (PATCH a row, a batch of updates)', () => {
  const sid = sheet([{ A: '1' }, { A: '2' }, { A: '3' }], ['A'])
  past(sid)
  const now = clock()
  assert.ok(!('fail' in patchRowById(ids(sid)[0], uid, { A: 'x' })))
  assert.ok(!('fail' in batchUpdateRows(sid, uid, [{ rowId: ids(sid)[2], cells: { A: 'y' } }], 'rest')))
  assert.deepEqual(changed(sid, now), [0, 2])
})

await ok('new rows: appended, imported from a CSV', async () => {
  const sid = sheet([{ A: '1' }], ['A'])
  past(sid)
  const now = clock()
  appendRows(sid, uid, [{ A: '2' }])
  const out = await importCsv(sid, uid, await scanCsvText('A\n3\n4\n'), false)
  assert.ok(!('fail' in out), JSON.stringify(out))
  await idle(sid)
  assert.deepEqual(changed(sid, now), [1, 2, 3])
})

await ok("a run's placeholders, its results, and the clear of what it left", async () => {
  const sid = sheet([{ N: 'a' }, { N: 'b' }, { N: 'c' }], ['N', 'Out'])
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status) VALUES (?,?,?,'Out','p','running')`)
    .run(id, sid, uid)
  past(sid)
  let now = clock()
  await seedProcessingPlaceholders({ run: { kind: 'ai', id }, sheetId: sid, userId: uid, columns: ['Out'],
    targets: [0, 2], lastRow: 2, live: () => true })
  assert.deepEqual(changed(sid, now), [0, 2])
  past(sid)
  now = clock()
  writeRunCells({ kind: 'ai', id }, sid, uid, 0, [['Out', 'done']])
  assert.deepEqual(changed(sid, now), [0])
  past(sid)
  now = clock()
  await clearProcessingPlaceholders(sid, uid, ['Out'])
  assert.deepEqual(changed(sid, now), [2], 'only the row still holding ⏳')
})

await ok('"Only run if": rows kept out get their mark, rows let in their placeholder', async () => {
  const sid = sheet([{ N: 'go' }, { N: 'no' }, { N: 'go' }], ['N', 'Out'])
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','running','Out')`).run(id, sid, uid)
  past(sid)
  const now = clock()
  const rule = { tree: checkRule('{{N}} is "go"', ['N', 'Out']).tree, columns: ['N'], markColumn: 'Out' }
  const out = await seedPlaceholdersByRule({ run: { kind: 'http', id }, sheetId: sid, userId: uid, columns: ['Out'],
    rule, targets: null, lastRow: 2, live: () => true })
  assert.deepEqual(out, { notMet: 1 })
  assert.deepEqual(changed(sid, now), [0, 1, 2])
})

await ok("a clean column's fill (the engine clean, formula and lookup columns share)", async () => {
  const sid = sheet([{ Name: '  Ada ' }, { Name: '' }, { Name: 'Grace' }], ['Name'])
  past(sid)
  const now = clock()
  const started = await startCleanColumn(uid, sid, { source: 'Name', cleaner: 'trim' })
  assert.ok('ok' in started, JSON.stringify(started))
  await waitForCleanFill(started.ok.id, 5_000)
  await idle(sid)
  assert.deepEqual(changed(sid, now), [0, 2], 'the empty row got no value, so it was not written')
})

await ok("a derived column's cell writer: an emptied cell (its key removed) and a new value are stamped", () => {
  const sid = sheet([{ A: 'x', D: 'old' }, { A: 'y', D: 'same' }, { A: 'z' }], ['A', 'D'])
  past(sid)
  const now = clock()
  const rows = (db.prepare(`SELECT rowid, row_index AS i, json_extract(data, '$.D') AS cell,
    json_extract(data, '$.A') AS in0 FROM rows WHERE sheet_id = ? ORDER BY row_index`).all(sid) as
    Array<Record<string, unknown>>).map(r => asDerivedRead(r, 1))
  // What a kind works out per row: empty (the key goes), the value it holds already, a new one.
  const values = ['', 'same', 'new']
  const pass = { compute: (inputs: unknown[][]) => inputs.map((_, k) => ({ value: values[k], filled: !!values[k] })),
    prepare: async () => {}, failure: () => null, dispose: () => {} }
  const counts = db.transaction(() => writeDerivedCells(uid, jsonPath('D'), rows, pass))()
  assert.deepEqual([counts.done, counts.changed.length], [3, 2])
  assert.deepEqual(changed(sid, now), [0, 2], 'the unchanged row is not written')
  const data = db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(sid) as string[]
  assert.deepEqual(data.map(d => JSON.parse(d).D), [undefined, 'same', 'new'])
})

await ok('an answer field filled from stored answers', async () => {
  const sid = sheet([{ Name: 'P0' }, { Name: 'P1' }], ['Name', 'Email', 'Title'])
  const runId = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,?,'completed','Email')`).run(runId, sid, uid, JSON.stringify({ responseMapping: [], enrichment: {} }))
  db.prepare(`INSERT INTO http_results (id,run_id,user_id,row_index,response_data,status)
    VALUES (?,?,?,1,?, 'completed')`)
    .run(uuid(), runId, uid, JSON.stringify({ output: { title: 'CTO' }, $fill: 'all' }))
  const job = uuid()
  db.prepare(`INSERT INTO enrichment_field_jobs (id,user_id,sheet_id,status_column,column_name,json_path)
    VALUES (?,?,?,'Email','Title','$.output.title')`).run(job, uid, sid)
  past(sid)
  const now = clock()
  await runFieldJob(job)
  assert.equal(JSON.parse(db.prepare('SELECT data FROM rows WHERE sheet_id = ? AND row_index = 1').pluck()
    .get(sid) as string).Title, 'CTO')
  assert.deepEqual(changed(sid, now), [1])
})

await ok('transform_column', async () => {
  const sid = sheet([{ A: 'x' }, { A: 'y' }], ['A'])
  past(sid)
  const now = clock()
  const out = await transformColumn(uid, { sheetId: sid, sourceColumn: 'A', targetColumn: 'B', operation: 'upper' })
  assert.ok('ok' in out, JSON.stringify(out))
  assert.deepEqual(changed(sid, now), [0, 1])
})

await ok('a column rename and a column delete rewrite the rows holding that cell', async () => {
  const sid = sheet([{ A: '1', B: 'b' }, { B: 'b' }, { A: '3' }], ['A', 'B'])
  past(sid)
  let now = clock()
  assert.ok('ok' in await renameSheetColumn(sid, uid, 'A', 'Alpha'))
  await idle(sid)
  assert.deepEqual(changed(sid, now), [0, 2])
  past(sid)
  now = clock()
  assert.ok('ok' in await deleteSheetColumn(sid, uid, 'B'))
  await idle(sid)
  assert.deepEqual(changed(sid, now), [0, 1])
})

await ok("a column delete that also drops dead run-input keys stamps only the rows holding the cell", async () => {
  const sid = sheet([{ A: '1', B: 'x' }, { B: 'y' }, { B: 'z' }], ['B'])
  const inputs = db.prepare('UPDATE rows SET run_inputs = ? WHERE sheet_id = ? AND row_index = ?')
  inputs.run('{"7":"fp","8":"keep"}', sid, 0)
  inputs.run('{"7":"fp"}', sid, 1)
  db.prepare('INSERT INTO run_input_purges (sheet_id, key) VALUES (?, 7)').run(sid)
  past(sid)
  const now = clock()
  await purgeColumnKey(sid, uid, 'A')
  assert.deepEqual(changed(sid, now), [0], 'a row holding only a dead key keeps its time')
  const after = db.prepare('SELECT data, run_inputs FROM rows WHERE sheet_id = ? ORDER BY row_index').all(sid)
  assert.deepEqual(after, [{ data: '{"B":"x"}', run_inputs: '{"8":"keep"}' }, { data: '{"B":"y"}', run_inputs: '{}' },
    { data: '{"B":"z"}', run_inputs: null }])
  assert.equal(db.prepare('SELECT COUNT(*) FROM run_input_purges WHERE sheet_id = ?').pluck().get(sid), 0)
})

await ok('rows restored from the trash count as changed now, not at their old time', async () => {
  const sid = sheet([{ A: '1' }, { A: '2' }, { A: '3' }], ['A'])
  past(sid)
  const item = db.transaction(() => deleteRowsToTrash(sid, uid, 'grid', { indexes: [1] }))().trashId!
  const now = clock()
  const out = await restoreRows(uid, item)
  assert.ok('ok' in out, JSON.stringify(out))
  await idle(sid)
  const back = db.prepare('SELECT updated_at FROM rows WHERE sheet_id = ? AND json_extract(data, ?) = ?').pluck()
    .get(sid, '$.A', '2') as string
  assert.ok(back >= now, back)
  assert.equal(db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND updated_at = ?').pluck().get(sid, PAST), 2)
})

await ok('a run undone puts cells back and stamps the rows it put back', async () => {
  const sid = sheet([{ N: 'a', Out: 'old' }, { N: 'b', Out: 'kept' }], ['N', 'Out'])
  const runId = await run(sid, 'ai', ['Out'], { 0: ['new'] }, { status: 'completed' })
  db.prepare(`UPDATE rows SET data = json_set(data, '$.Out', 'kept') WHERE sheet_id = ? AND row_index = 1`).run(sid)
  past(sid)
  const now = clock()
  const out = await undoRun(uid, 'ai', runId)
  assert.ok('ok' in out, JSON.stringify(out))
  await idle(sid)
  assert.deepEqual(changed(sid, now), [0])
})

await ok('a sort only moves rows: every time stays', async () => {
  const sid = sheet([{ A: 'c' }, { A: 'a' }, { A: 'b' }], ['A'])
  past(sid)
  const before = ids(sid)
  const out = await physicalSortSheet(sid, uid, 'A', 'asc')
  assert.ok(!('fail' in out), JSON.stringify(out))
  await idle(sid)
  assert.notDeepEqual(ids(sid), before)
  assert.deepEqual(changed(sid, '9999'), [])
})

done()
