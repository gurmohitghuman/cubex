// List jobs as their destination sheet sees them, against a migrated throwaway
// DB. A rename or delete of a destination column rewrites the runs adding rows
// into it a page at a time after the switch, with the sheet busy: a restart
// mid-way finishes it, two renames and a delete after a rename go in order, a
// rewrite recorded before migration 021 skips that pass, and nothing acts on
// the old names meanwhile (the drain waits, a start refuses). Results that
// replace rows a run on the destination may still fill wait for it, say which
// run, and hold neither the column nor other source rows. A full destination's
// pause message is redacted.
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

async function main() {
  const { db } = await import('../../server/src/lib/db')
  const { runMigrations } = await import('../../server/src/db/migrate')
  const { sheetBusyWith, withSheetBusy } = await import('../../server/src/lib/sheet-busy')
  const { RUNS_PAGE } = await import('../../server/src/lib/http-columns')
  const { renameListDestPage } = await import('../../server/src/lib/list-dest-columns')
  const RW = await import('../../server/src/services/run-config-rewrite')
  const { renameSheetColumn } = await import('../../server/src/services/column-rename')
  const { deleteSheetColumn } = await import('../../server/src/services/column-delete')
  const { destMoved, planListDest } = await import('../../server/src/services/enrich-list-dest')
  const { addListItems } = await import('../../server/src/services/enrich-list-add')
  const { drainListItems } = await import('../../server/src/services/enrich-list-drain')
  const { listRowsBeingAdded } = await import('../../server/src/services/enrich-list-start')
  const { stopForRoom } = await import('../../server/src/services/enrich-list-source')
  runMigrations()
  console.warn = () => {}

  const uid = uuid(), tableId = uuid(), src = uuid(), dest = uuid(), dest2 = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'Leads')
  const sheet = db.prepare(`INSERT INTO sheets (id, table_id, user_id, name, position, column_order)
    VALUES (?,?,?,?,?,?)`)
  sheet.run(src, tableId, uid, 'Leads', 0, JSON.stringify(['Company', 'People']))
  sheet.run(dest, tableId, uid, 'People', 1, JSON.stringify(['Company', 'Name', 'Title']))
  sheet.run(dest2, tableId, uid, 'Contacts', 2, JSON.stringify(['Company', 'Name']))
  const rowIds = [uuid(), uuid(), uuid()]
  rowIds.forEach((id, i) => db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    .run(id, src, uid, i, JSON.stringify({ Company: `Co${i}`, People: '➕ Adding 1 row…' })))
  const list = (to: string, fields: string[]) => ({
    destSheetId: to, itemsPath: '$.output.people', provider: null, maxItems: 10,
    fields: fields.map(f => ({ path: '$.name', columnName: f })), copy: [{ id: 'c1', from: 'Company', to: 'Company' }],
    dedupe: null,
  })
  const insertRun = db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows,
    master_column_name, dest_sheet_id) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`)
  const run = (to: string, fields: string[], status = 'completed') => {
    const id = uuid()
    insertRun.run(id, src, uid, JSON.stringify({ requestConfig: {}, responseMapping: [],
      enrichment: { v: 1, list: list(to, fields) } }), status, 'People', to)
    return id
  }
  const journal = (runId: string, rowId: string, names: string[], to = dest) => {
    const id = uuid()
    db.prepare(`INSERT INTO enrichment_list_items (id, user_id, run_id, source_sheet_id, source_row_id,
      dest_sheet_id, items_json, item_count) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, uid, runId, src, rowId, to, JSON.stringify({ items: names.map(n => ({ name: n })), copy: { c1: 'Co' } }),
        names.length)
    return id
  }
  const intoDest = () => (db.prepare('SELECT config FROM http_runs WHERE dest_sheet_id = ? ORDER BY rowid')
    .pluck().all(dest) as string[]).flatMap(c => { try { return [JSON.parse(c).enrichment.list] } catch { return [] } })
  const fieldNames = () => new Set(intoDest().map(l => (l.fields ?? []).map((f: { columnName: string }) =>
    f.columnName).join('+')))
  const idle = async (sid: string) => { while (sheetBusyWith(sid)) await new Promise(r => setTimeout(r, 5)) }
  const pending = () => db.prepare('SELECT COUNT(*) FROM run_config_rewrites').pluck().get() as number

  // --- A destination's rename: paged, and a restart finishes it ------------------
  const MANY = RUNS_PAGE * 2 + 50
  db.transaction(() => { for (let i = 0; i < MANY; i++) run(dest, ['Name', 'Title']) })()
  const bad = uuid()
  insertRun.run(bad, src, uid, 'not json', 'completed', 'People', dest)
  db.transaction(() => RW.recordRunRewrite(dest, uid, 'Name', 'Full name'))()
  check('the switch only records the rewrite of the runs into the sheet (none read in it)',
    fieldNames().size === 1 && fieldNames().has('Name+Title') && pending() === 1)
  // A crash after the first page of runs into the sheet committed.
  db.transaction(() => {
    const next = renameListDestPage(dest, uid, 'Name', 'Full name', Number.MAX_SAFE_INTEGER, RUNS_PAGE)
    db.prepare('UPDATE run_config_rewrites SET before_rowid = 0, dest_before_rowid = ?').run(next)
  })()
  check('half-way: the newest page renamed, the rest not yet', fieldNames().has('Full name+Title')
    && fieldNames().has('Name+Title'))
  RW.resumeRunRewrites()
  check('a restart marks the sheet busy before anything else runs', !!sheetBusyWith(dest))
  db.prepare("UPDATE rows SET data = json_set(data, '$.People', '➕ Adding 1 row…') WHERE id = ?").run(rowIds[0])
  const jBusy = journal(run(dest, ['Full name', 'Title']), rowIds[0], ['Ada'])
  await drainListItems()
  check('meanwhile the drain adds nothing there',
    (db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ?').pluck().get(dest) as number) === 0)
  const plan = planListDest(uid, src, { dest: { sheetId: dest }, provider: null, maxItems: 5,
    fields: [{ path: '$.name', columnName: 'Name' }], copy: [], dedupePath: null }, ['Company', 'People'])
  check('and a run start into it is refused as busy', 'fail' in plan && plan.fail === 'conflict')
  await idle(dest)
  check('then every run into the sheet keeps the new name, once',
    fieldNames().size === 1 && fieldNames().has('Full name+Title') && pending() === 0)
  check('a malformed config is left as it is',
    db.prepare('SELECT config FROM http_runs WHERE id = ?').pluck().get(bad) === 'not json')
  await drainListItems()
  check('and the waiting results go in after', 'gone' in addListItems(jBusy)
    && (db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ?').pluck().get(dest) as number) === 1)
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?')
    .run(JSON.stringify(['Company', 'Full name', 'Title']), dest)

  // --- Renames and a delete, in order --------------------------------------------
  await withSheetBusy(dest, 'testing', async () => {
    db.transaction(() => RW.recordRunRewrite(dest, uid, 'Title', 'Role'))()
    db.transaction(() => RW.recordRunRewrite(dest, uid, 'Role', 'Job'))()
    db.transaction(() => RW.recordRunRewrite(dest, uid, 'Full name', null))()
    await RW.finishRunRewrites(dest)
  })
  check('a rename, a rename again and a delete before the pages finish land in order',
    fieldNames().size === 1 && fieldNames().has('Job') && pending() === 0)
  db.prepare(`INSERT INTO run_config_rewrites (sheet_id, user_id, old_name, new_name, before_rowid)
    VALUES (?, ?, 'Job', 'Ignored', ?)`).run(dest, uid, Number.MAX_SAFE_INTEGER)
  await withSheetBusy(dest, 'testing', () => RW.finishRunRewrites(dest))
  check('a rewrite recorded before migration 021 skips the runs into the sheet (its switch did them)',
    fieldNames().has('Job') && pending() === 0)

  // --- The real rename and delete ---------------------------------------------
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(['Company', 'Job']), dest)
  const renamed = await renameSheetColumn(dest, uid, 'Job', 'Position')
  await idle(dest)
  check('renaming the column rewrites every run into the sheet',
    'ok' in renamed && fieldNames().size === 1 && fieldNames().has('Position') && pending() === 0)
  const deleted = await deleteSheetColumn(dest, uid, 'Company')
  await idle(dest)
  check('deleting a copied-into column: no run copies into it anymore',
    'ok' in deleted && intoDest().every(l => l.copy.length === 0))

  // --- A start that read the sheet before a rename --------------------------------
  const fills = { fields: [{ path: '$.name', columnName: 'Job' }], copy: [] }
  check('a start whose column was renamed meanwhile is refused',
    (destMoved(uid, dest, 'People', fills, []) ?? '').includes('changed meanwhile')
    && destMoved(uid, dest, 'People', fills, ['Job']) === null
    && destMoved(uid, dest, 'People', { fields: [{ path: '$.name', columnName: 'Position' }], copy: [] }, []) === null)

  // --- A run on the destination -------------------------------------------------
  const contacts = () => db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
    .all(dest2).map(d => JSON.parse(d as string).Name as string)
  const cell = (id: string) => JSON.parse(db.prepare('SELECT data FROM rows WHERE id = ?').pluck().get(id) as string)
    .People as string
  const wait = (id: string) => db.prepare('SELECT wait_reason FROM enrichment_list_items WHERE id = ?').pluck().get(id)
  const version = () => db.prepare('SELECT data_version FROM sheets WHERE id = ?').pluck().get(src)
  const blockedColumn = () => !!listRowsBeingAdded(src, uid, 'People')
  addListItems(journal(run(dest2, ['Name']), rowIds[0], ['Old0'], dest2))
  const blocker = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name)
    VALUES (?, ?, ?, '{}', 'running', 'Email')`).run(blocker, dest2, uid)
  const blockerIs = (status: string) => db.prepare('UPDATE http_runs SET status = ? WHERE id = ?').run(status, blocker)
  for (const id of rowIds) {
    db.prepare("UPDATE rows SET data = json_set(data, '$.People', '➕ Adding 1 row…') WHERE id = ?").run(id)
  }
  const jOld = journal(run(dest2, ['Name']), rowIds[0], ['Mid0'], dest2)
  const jOther = journal(run(dest2, ['Name']), rowIds[1], ['First1'], dest2)
  const jNew = journal(run(dest2, ['Name']), rowIds[0], ['New0'], dest2)
  await drainListItems()
  check('results replacing rows under a running run wait, still being added (the column waits)',
    wait(jOld) === null && wait(jNew) === null && blockedColumn() && contacts().join() === 'Old0,First1')
  check('another source row\'s results go on meanwhile',
    wait(jOther) === undefined && cell(rowIds[1]).startsWith('✅'))
  blockerIs('paused')
  await drainListItems()
  check('under a paused run they wait, recorded, and no longer hold the column',
    wait(jOld) === 'dest_run' && wait(jNew) === 'dest_run' && !blockedColumn())
  check('the source row names the paused run and what to do',
    cell(rowIds[0]) === '➕ 1 row wait: the Email run in Contacts is paused. Resume or cancel it')
  const before = version()
  await drainListItems()
  check('the next round neither adds them nor writes the cell again',
    contacts().join() === 'Old0,First1' && version() === before)
  blockerIs('running')
  await drainListItems()
  check('resumed: they wait for it as being added again', wait(jOld) === null && wait(jNew) === null && blockedColumn())
  blockerIs('cancelled')
  await drainListItems()
  check('once the run ends they go, oldest first (the newest results stay)',
    wait(jOld) === undefined && wait(jNew) === undefined && contacts().join() === 'First1,New0'
    && cell(rowIds[0]) === '✅ 1 row added' && !blockedColumn())

  // --- A full destination's pause message is redacted ----------------------------
  const full = run(dest2, ['Name'], 'running')
  stopForRoom(full, 'Leads sk-ant-abcdefghijklmnop')
  const message = db.prepare('SELECT error_message FROM http_runs WHERE id = ?').pluck().get(full) as string
  check('the pause message never stores a key-shaped sheet name',
    !message.includes('abcdefghijklmnop') && message.includes('[REDACTED]'))

  if (failures) { console.error(`\n${failures} failed`); process.exit(1) }
  console.log('\nall list destination checks passed')
}

main().catch(err => { console.error(err); process.exit(1) })
