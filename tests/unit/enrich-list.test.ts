// List results into rows against a migrated throwaway DB: the pure parts
// (paths, results, fields, cells, duplicate keys, the request parser), then
// the journal drain (one transaction per source row: rows, provenance, the
// source cell; no double add; a rerun replaces; duplicates skipped; a full
// sheet waits and pauses the run; results wait for fields), the destination
// guards, a deleted destination, column renames and deletes, and the run
// markers auto-run reads as empty.
// Over 200 lines: one script over one pair of sheets; split, each part would rebuild them.
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
// A small row limit, so a "full" sheet takes a few rows (read when constants load).
process.env.MAX_ROWS_PER_SHEET = '40'

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

async function main() {
  const { db } = await import('../../server/src/lib/db')
  const { runMigrations } = await import('../../server/src/db/migrate')
  const L = await import('../../server/src/lib/enrich-list')
  const { parseListInput } = await import('../../server/src/lib/enrich-list-input')
  const { holdsRunMarker } = await import('../../server/src/lib/enrich-seed')
  const { addListItems } = await import('../../server/src/services/enrich-list-add')
  const { drainListItems } = await import('../../server/src/services/enrich-list-drain')
  const { giveFields, fieldlessRuns } = await import('../../server/src/services/enrich-list-held')
  const { listRowsBeingAdded } = await import('../../server/src/services/enrich-list-start')
  const { listRunInto, lastKeptField, resultsNotAdded } = await import('../../server/src/services/enrich-list-guard')
  const { withSheetBusy } = await import('../../server/src/lib/sheet-busy')
  const { abortListRunsInto } = await import('../../server/src/services/run-control')
  const { renameHttpRunColumnRefs, deleteHttpRunColumnRefs } = await import('../../server/src/lib/http-columns')
  const { activeRunInputError } = await import('../../server/src/lib/ai-prompt-inputs')
  runMigrations()

  // --- Pure ------------------------------------------------------------------
  const answer = {
    output: { people: [{ name: 'Ada', company: { domain: 'a.example' }, tags: ['x'] }, null, { name: 'Grace' }] },
  }
  check('readPath walks keys, quoted keys and indexes',
    L.readPath(answer, '$.output.people[0].company.domain') === 'a.example'
    && L.readPath({ 'a b': 1 }, '$["a b"]') === 1 && L.readPath(answer, '$.nope.x') === undefined)
  const items = L.itemsOf(answer, '$.output.people', 10)
  check('itemsOf keeps the list (nulls out) up to the max', items.length === 2
    && L.itemsOf(answer, '$.output.people', 1).length === 1 && L.itemsOf(answer, '$.output', 5).length === 0)
  const fields = L.discoverFields(items)
  const byPath = new Map(fields.map(f => [f.path, f]))
  check('fields: leaf paths, nested objects walked, a list kept as one field',
    byPath.has('$.name') && byPath.has('$.company.domain') && byPath.has('$.tags'))
  check('fields count the results that fill them, with a sample',
    byPath.get('$.name')!.filled === 2 && byPath.get('$.company.domain')!.filled === 1
    && byPath.get('$.name')!.sample === 'Ada')
  check('itemCells writes each kept field (objects as text, missing as empty)',
    JSON.stringify(L.itemCells(items[0], [{ path: '$.tags', columnName: 'Tags' }, { path: '$.x', columnName: 'X' }]))
      === JSON.stringify({ Tags: '["x"]', X: '' }))
  check('dedupe keys: same path and value match, empty never does',
    L.dedupeKey({ u: ' A ' }, '$.u') === L.dedupeKey({ u: 'A' }, '$.u') && L.dedupeKey({ u: '' }, '$.u') === null
    && L.dedupeKey({ u: 'A' }, '$.v') === null)
  check('cell words', L.listCell.adding(12) === '➕ Adding 12 rows…' && L.listCell.added(1, 0) === '✅ 1 row added'
    && L.listCell.added(3, 7) === '✅ 3 rows added, 7 already there'
    && L.listCell.added(0, 7) === '✅ All 7 already there'
    && L.listCell.waitingFields(5) === '➕ 5 results, waiting for fields')
  check('➕, ⏳, ❌ and ⏭️ are run markers, not data', holdsRunMarker('➕ Adding 3 rows…')
    && holdsRunMarker('⏳ Processing...') && holdsRunMarker(' ❌ Failed') && !holdsRunMarker('Acme'))
  check('copied cells: a run marker copies as empty', JSON.stringify(L.copyValues(
    { copy: [{ id: 'c1', from: 'A', to: 'A' }, { id: 'c2', from: 'B', to: 'B' }] } as never,
    { A: 'Acme', B: '➕ Adding 3 rows…' })) === JSON.stringify({ c1: 'Acme', c2: '' }))

  const good = parseListInput({ dest: { newSheetName: 'People' }, provider: 'quickenrich', maxItems: 5,
    fields: [{ path: '$.name', columnName: 'Name' }], copy: [{ from: 'Company' }], dedupePath: '$.name' })
  check('list input parses (copy to defaults to its from)', typeof good === 'object' && good !== null
    && good.copy[0].to === 'Company' && good.dedupePath === '$.name' && good.maxItems === 5)
  const bad = (v: unknown) => typeof parseListInput(v) === 'string'
  check('list input refuses a bad page size, a filter path, a dedupe not kept, no destination',
    bad({ dest: { newSheetName: 'P' }, maxItems: 101 })
    && bad({ dest: { newSheetName: 'P' }, fields: [{ path: '$..x', columnName: 'X' }] })
    && bad({ dest: { newSheetName: 'P' }, fields: [{ path: '$.a', columnName: 'A' }], dedupePath: '$.b' })
    && bad({ provider: 'x' }))
  check('fields may wait for the results',
    (parseListInput({ dest: { sheetId: uuid() } }) as { fields: null }).fields === null)

  // --- Fixtures ----------------------------------------------------------------
  const uid = uuid(), tableId = uuid(), src = uuid(), dest = uuid(), other = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'Leads')
  const sheet = db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
  sheet.run(src, tableId, uid, 'Leads', JSON.stringify(['Company', 'People']))
  sheet.run(dest, tableId, uid, 'People', JSON.stringify(['Company', 'Name']))
  sheet.run(other, tableId, uid, 'Other', JSON.stringify(['Company', 'Name']))
  const rowIds = [uuid(), uuid(), uuid()]
  rowIds.forEach((id, i) => db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    .run(id, src, uid, i, JSON.stringify({ Company: `Co${i}`, People: '➕ Adding 2 rows…' })))
  const list = (extra: Record<string, unknown> = {}) => ({
    destSheetId: dest, itemsPath: '$.output.people', provider: 'quickenrich', maxItems: 10,
    fields: [{ path: '$.name', columnName: 'Name' }], copy: [{ id: 'c1', from: 'Company', to: 'Company' }],
    dedupe: null, ...extra,
  })
  const run = (cfg: Record<string, unknown>, status = 'completed', to = dest) => {
    const id = uuid()
    db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name,
      dest_sheet_id) VALUES (?, ?, ?, ?, ?, 0, 'People', ?)`)
      .run(id, src, uid, JSON.stringify({ requestConfig: {}, responseMapping: [], enrichment: { v: 1, list: cfg } }),
        status, to)
    return id
  }
  const journal = (runId: string, rowId: string, names: string[], wait: string | null = null, to = dest) => {
    const id = uuid()
    db.prepare(`INSERT INTO enrichment_list_items (id, user_id, run_id, source_sheet_id, source_row_id,
      dest_sheet_id, items_json, item_count, wait_reason) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, uid, runId, src, rowId, to,
        JSON.stringify({ items: names.map(n => ({ name: n })), copy: { c1: 'Co' } }), names.length, wait)
    return id
  }
  const otherRows = () => db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
    .all(other).map(d => JSON.parse(d as string).Name as string)
  const destRows = () => db.prepare('SELECT id, row_index, data FROM rows WHERE sheet_id = ? ORDER BY row_index')
    .all(dest) as Array<{ id: string; row_index: number; data: string }>
  const cell = (rowId: string) => (JSON.parse((db.prepare('SELECT data FROM rows WHERE id = ?').get(rowId) as
    { data: string }).data) as Record<string, string>).People

  // --- Drain -----------------------------------------------------------------------
  const r1 = run(list())
  const j1 = journal(r1, rowIds[0], ['Ada', 'Grace'])
  check('a running list run into the sheet holds it', listRunInto(dest, uid) !== null)
  check('rows being added hold a new run on the column', !!listRowsBeingAdded(src, uid, 'People'))
  const out = addListItems(j1)
  check('a journal row adds its rows', 'added' in out && out.added === 2 && destRows().length === 2)
  const added = destRows()
  check('each row has the copied and kept cells',
    JSON.parse(added[0].data).Company === 'Co' && JSON.parse(added[0].data).Name === 'Ada')
  check('the source cell says what was added', cell(rowIds[0]) === '✅ 2 rows added')
  check('provenance for each row', (db.prepare('SELECT COUNT(*) FROM enrichment_list_rows WHERE run_id = ?')
    .pluck().get(r1) as number) === 2)
  check('the run counts them', (db.prepare('SELECT list_rows_added FROM http_runs WHERE id = ?').pluck().get(r1)) === 2)
  check('the journal row is gone, so it never adds twice', 'gone' in addListItems(j1) && destRows().length === 2)
  check('nothing pending: the sheet is free again',
    listRunInto(dest, uid) === null && !listRowsBeingAdded(src, uid, 'People'))

  // A rerun of the same source row replaces its rows (added above the old ones).
  db.prepare("UPDATE rows SET data = json_set(data, '$.People', '➕ Adding 1 row…') WHERE id = ?").run(rowIds[0])
  const r2 = run(list())
  addListItems(journal(r2, rowIds[0], ['Barbara']))
  const after = destRows()
  check('a rerun replaces the rows its source row added',
    after.length === 1 && JSON.parse(after[0].data).Name === 'Barbara' && after[0].row_index > added[1].row_index)

  // Skip results already added (by the kept field).
  db.prepare("UPDATE rows SET data = json_set(data, '$.People', '➕') WHERE id IN (?, ?)").run(rowIds[1], rowIds[2])
  const r3 = run(list({ dedupe: { path: '$.name' } }))
  addListItems(journal(r3, rowIds[1], ['Edsger', 'Ken', 'Edsger']))
  const dup = addListItems(journal(r3, rowIds[2], ['Ken', 'Radia']))
  check('a duplicate (in the batch or in the sheet) is skipped',
    'added' in dup && dup.added === 1 && dup.skipped === 1 && cell(rowIds[1]) === '✅ 2 rows added, 1 already there')

  // Waiting for fields, then given them.
  const r4 = run(list({ fields: null }))
  db.prepare("UPDATE rows SET data = json_set(data, '$.People', '➕ 1 result, waiting for fields') WHERE id = ?")
    .run(rowIds[2])
  const j4 = journal(r4, rowIds[2], ['Alan'], 'fields')
  check('results waiting for fields hold neither the sheet nor the column',
    listRunInto(dest, uid) === null && !listRowsBeingAdded(src, uid, 'People'))
  check('without fields it waits', 'wait' in addListItems(j4))
  const held = fieldlessRuns(src, uid, 'People')
  check('the column finds its runs without fields', held.some(r => r.id === r4))
  db.transaction(() => giveFields(uid, held, [{ path: '$.name', columnName: 'Name' }], null))()
  check('picked fields release the results', (db.prepare('SELECT wait_reason FROM enrichment_list_items WHERE id = ?')
    .pluck().get(j4)) === null)
  check('and their rows say the rows are on their way', cell(rowIds[2]) === '➕ Adding 1 row…')
  await drainListItems()
  check('the loop adds them',
    cell(rowIds[2]).startsWith('✅') && destRows().some(r => JSON.parse(r.data).Name === 'Alan'))

  // A full sheet: the journal row waits for room and the run pauses.
  const fill = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
  for (let i = 0; i < 36; i++) fill.run(uuid(), dest, uid, 1000 + i, '{}')
  const r5 = run(list(), 'running')
  db.prepare("UPDATE rows SET data = json_set(data, '$.People', '➕ Adding 3 rows…') WHERE id = ?").run(rowIds[1])
  const j5 = journal(r5, rowIds[1], ['A1', 'A2', 'A3', 'A4'])
  check('a full sheet: the results wait for room',
    'wait' in addListItems(j5) && cell(rowIds[1]).includes('waiting for room in People'))
  check('and the run pauses', (db.prepare('SELECT status FROM http_runs WHERE id = ?').pluck().get(r5)) === 'paused')
  check('waiting for room never holds the sheet (deleting rows makes room)', listRunInto(dest, uid) === null)
  // One queued behind it waits for room too (else it would hold the sheet against the delete that makes room).
  db.prepare("UPDATE rows SET data = json_set(data, '$.People', '➕ Adding 1 row…') WHERE id = ?").run(rowIds[0])
  const j5b = journal(r5, rowIds[0], ['B1'])
  await drainListItems()
  check('a journal row queued behind a full sheet waits for room too, and its row says so',
    (db.prepare('SELECT wait_reason FROM enrichment_list_items WHERE id = ?').pluck().get(j5b)) === 'room'
    && cell(rowIds[0]).includes('waiting for room') && listRunInto(dest, uid) === null)
  db.prepare('DELETE FROM enrichment_list_items WHERE id = ?').run(j5b)

  // Bad results keep failing: marked failed after a few tries, and the row says why.
  db.prepare("DELETE FROM enrichment_list_items WHERE id = ?").run(j5)
  const r6 = run(list())
  const j6 = uuid()
  db.prepare(`INSERT INTO enrichment_list_items (id, user_id, run_id, source_sheet_id, source_row_id,
    dest_sheet_id, items_json) VALUES (?,?,?,?,?,?,?)`).run(j6, uid, r6, src, rowIds[1], dest, 'not json')
  for (let i = 0; i < 5; i++) await drainListItems()
  check('a journal row that keeps failing is marked failed, and its row says so',
    (db.prepare('SELECT status FROM enrichment_list_items WHERE id = ?').pluck().get(j6)) === 'failed'
    && cell(rowIds[1]).startsWith('❌ Rows not added'))
  check('a failed journal row keeps its results (they were paid for)',
    db.prepare('SELECT items_json FROM enrichment_list_items WHERE id = ?').pluck().get(j6) === 'not json')

  // A full sheet with a long queue never holds rows into another sheet.
  const r9 = run(list(), 'paused')
  const queued = db.transaction(() => Array.from({ length: 205 }, () => journal(r9, rowIds[2], ['Q'], 'room')))()
  const r10 = run(list({ destSheetId: other }), 'completed', other)
  db.prepare("UPDATE rows SET data = json_set(data, '$.People', '➕ Adding 1 row…') WHERE id = ?").run(rowIds[0])
  journal(r10, rowIds[0], ['Elsewhere'], null, other)
  await drainListItems()
  check('one destination waiting for room never holds another (each goes on its own)',
    otherRows().includes('Elsewhere') && listRunInto(other, uid) === null)
  const notAdded = resultsNotAdded(src, uid)
  check('results not added yet are counted, with where they go (the delete confirm says so)',
    !!notAdded && notAdded.results === db.prepare(`SELECT SUM(item_count) FROM enrichment_list_items
      WHERE source_sheet_id = ? AND status = 'pending'`).pluck().get(src)
    && notAdded.sheets.join() === 'People' && resultsNotAdded(other, uid) === null)

  // The loop never holds a sheet (a run start or a pick there is never "busy"), and waits out a sort.
  journal(r10, rowIds[0], ['Second'], null, other)
  journal(r10, rowIds[0], ['Third'], null, other)
  const draining = drainListItems()
  const claim = await withSheetBusy(other, 'testing', async () => 'free')
  await draining
  check('while rows are being added, the sheet can still be claimed', claim === 'free')
  let release = () => {}
  const sorting = withSheetBusy(other, 'sorting', () => new Promise<void>(r => { release = r }))
  journal(r10, rowIds[0], ['Fourth'], null, other)
  await drainListItems()
  check('a sort on the destination holds its rows back', !otherRows().includes('Fourth'))
  release()
  await sorting
  await drainListItems()
  check('and they go in once it ends', otherRows().includes('Fourth'))
  db.prepare('DELETE FROM enrichment_list_items WHERE id IN (SELECT value FROM json_each(?))')
    .run(JSON.stringify(queued))

  // Two runs' results for one source row: the older one never writes over the newer one's words.
  db.prepare("UPDATE rows SET data = json_set(data, '$.People', '➕ Adding 1 row…') WHERE id = ?").run(rowIds[1])
  const jOld = journal(r10, rowIds[1], ['Older'], null, other)
  const r11 = run(list({ destSheetId: other }), 'completed', other)
  const jNew = journal(r11, rowIds[1], ['Newer'], null, other)
  addListItems(jOld)
  check('an older run\'s results leave the cell to the newer run still on its way',
    cell(rowIds[1]) === '➕ Adding 1 row…' && otherRows().includes('Older'))
  addListItems(jNew)
  check('the newer run replaces the rows and writes the cell',
    cell(rowIds[1]) === '✅ 1 row added' && otherRows().includes('Newer') && !otherRows().includes('Older'))

  // Renames and deletes follow both sheets.
  const r7 = run(list())
  db.transaction(() => renameHttpRunColumnRefs(dest, uid, 'Name', 'Full name'))()
  db.transaction(() => renameHttpRunColumnRefs(src, uid, 'Company', 'Org'))()
  const listOfRun = (id: string) =>
    JSON.parse(db.prepare('SELECT config FROM http_runs WHERE id = ?').pluck().get(id) as string).enrichment.list
  const cfg7 = listOfRun(r7)
  check('a rename rewrites kept fields (destination) and copied columns (source)',
    cfg7.fields[0].columnName === 'Full name' && cfg7.copy[0].from === 'Org')
  db.transaction(() => deleteHttpRunColumnRefs(dest, uid, 'Company'))()
  const cfg7b = listOfRun(r7)
  check('a deleted destination column is no longer filled', cfg7b.copy.length === 0)
  db.transaction(() => deleteHttpRunColumnRefs(dest, uid, 'Full name'))()
  check('the last kept field deleted: fields to pick again, never blank rows', listOfRun(r7).fields === null)
  db.prepare("UPDATE rows SET data = json_set(data, '$.People', '➕ Adding 1 row…') WHERE id = ?").run(rowIds[2])
  const j7 = journal(r7, rowIds[2], ['Nobody'])
  check('so its results wait for fields, and the row says so',
    'wait' in addListItems(j7) && cell(rowIds[2]) === '➕ 1 result, waiting for fields')
  db.prepare('DELETE FROM enrichment_list_items WHERE id = ?').run(j7)

  // The destination deleted: its list runs are cancelled and waiting rows say so.
  const r8 = run(list(), 'running')
  check("a running list job's only kept field can't be deleted",
    (lastKeptField(dest, uid, 'Name') ?? '').includes("it's the only field")
    && lastKeptField(dest, uid, 'Company') === null)
  check('a column a running list job copies can\'t be renamed or deleted',
    (activeRunInputError(src, uid, 'Company', 'rename') ?? '').includes('copies it into the rows it adds'))
  db.prepare("UPDATE rows SET data = json_set(data, '$.People', '➕ Adding 1 row…') WHERE id = ?").run(rowIds[0])
  journal(r8, rowIds[0], ['Z'])
  const cancelled = db.transaction(() => abortListRunsInto([dest]))()
  check('deleting the destination cancels its list runs and tells their rows',
    cancelled.includes(r8) && (db.prepare('SELECT status FROM http_runs WHERE id = ?').pluck().get(r8)) === 'cancelled'
    && cell(rowIds[0]).startsWith('❌ Rows not added: the sheet for them was deleted'))

  if (failures) { console.error(`\n${failures} failed`); process.exit(1) }
  console.log('\nall list checks passed')
}

main().catch(err => { console.error(err); process.exit(1) })
