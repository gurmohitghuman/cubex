// Row-write replays whatever happened to the sheet since (services/rows-write-keyed.ts):
// all three forms replay after the sheet went to the trash, where a new key is
// "Sheet not found"; a many-row update's replay answers while the sheet is busy,
// through the /api/v1 gate (routes/api-v1-shared.ts) and the MCP one
// (mcp/tool-helpers.ts), while a call that would write, or one without a key,
// is refused as busy; and auto-dedupe's restore words come back in the words of
// the surface asking, never stored.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import keyedMod from '../../server/src/services/rows-write-keyed'
import trashMod from '../../server/src/services/trash-sheets'
import busyMod from '../../server/src/lib/sheet-busy'
import sharedMod from '../../server/src/routes/api-v1-shared'
import helpersMod from '../../server/src/mcp/tool-helpers'
import settingMod from '../../server/src/services/auto-dedupe-setting'
import indexMod from '../../server/src/services/auto-dedupe-index'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { appendRowsKeyed, patchRowKeyed, batchUpdateKeyed } =
  keyedMod as typeof import('../../server/src/services/rows-write-keyed')
const { trashTable } = trashMod as typeof import('../../server/src/services/trash-sheets')
const { withSheetBusy, refuseChangesWhileBusy, busyMessage } =
  busyMod as typeof import('../../server/src/lib/sheet-busy')
const { V1_SHEET_BUSY_ALLOWED } = sharedMod as typeof import('../../server/src/routes/api-v1-shared')
const { refuseWhileSheetBusy } = helpersMod as typeof import('../../server/src/mcp/tool-helpers')
const { setAutoDedupe } = settingMod as typeof import('../../server/src/services/auto-dedupe-setting')
const { maintainAutoDedupeSheet } = indexMod as typeof import('../../server/src/services/auto-dedupe-index')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
function sheet(rows: Array<Record<string, string>> = []): { table: string; sheet: string; rows: string[] } {
  const table = uuid(), id = uuid()
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(table, uid, `T ${table}`)
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
    .run(id, table, uid, 'S', JSON.stringify(['Name', 'Email']))
  const ins = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
  const ids = rows.map((r, i) => { const rid = uuid(); ins.run(rid, id, uid, i, JSON.stringify(r)); return rid })
  return { table, sheet: id, rows: ids }
}
const done = <T>(r: T | { fail: string }): T => {
  assert.ok(!('fail' in (r as object)), JSON.stringify(r))
  return r as T
}
const stored = (key: string) => db.prepare('SELECT result_json FROM data_operation_ledger WHERE idempotency_key = ?')
  .pluck().get(key) as string

await ok('after the sheet went to the trash all three forms replay; a new key there is "sheet not found"', () => {
  const s = sheet()
  const ap = done(appendRowsKeyed(s.sheet, uid, [{ Name: 'a' }], 'tr-ap', 'mcp'))
  const row = (ap.ok.answer.rows as Array<{ id: string }>)[0].id
  const up = done(patchRowKeyed(row, uid, { Email: 'a@x.io' }, s.sheet, 'tr-up', 'mcp'))
  const bt = done(batchUpdateKeyed(s.sheet, uid, [{ rowId: row, cells: { Name: 'b' } }], 'tr-bt', 'mcp'))
  assert.ok('ok' in trashTable(uid, s.table))
  const apAgain = done(appendRowsKeyed(s.sheet, uid, [{ Name: 'a' }], 'tr-ap', 'rest'))
  assert.deepEqual([apAgain.replayed, apAgain.ok.answer], [true, ap.ok.answer])
  assert.deepEqual(patchRowKeyed(row, uid, { Email: 'a@x.io' }, s.sheet, 'tr-up', 'rest'), { ...up, replayed: true })
  assert.deepEqual(batchUpdateKeyed(s.sheet, uid, [{ rowId: row, cells: { Name: 'b' } }], 'tr-bt', 'rest'),
    { ...bt, replayed: true })
  assert.deepEqual(appendRowsKeyed(s.sheet, uid, [{ Name: 'a' }], 'tr-ap-2', 'mcp'), { fail: 'sheet_not_found' })
  assert.deepEqual(batchUpdateKeyed(s.sheet, uid, [{ rowId: row, cells: { Name: 'c' } }], 'tr-bt-2', 'mcp'),
    { fail: 'sheet_not_found' })
})

// A fake express request to a sheet route, its body parsed, and a response that keeps what was sent.
const request = (body: Record<string, unknown>, headers: Record<string, string> = {}, sheetId = '') => ({
  method: 'POST', path: '/rows/update', params: { id: sheetId }, body,
  get: (h: string) => headers[h.toLowerCase()],
})
const response = () => {
  const r = {
    code: 0, body: null as unknown,
    status(c: number) { r.code = c; return r },
    json(b: unknown) { r.body = b; return r },
  }
  return r
}

await ok('a busy sheet: a many-row update\'s replay answers on both surfaces; a write or no key is refused',
  async () => {
  const s = sheet([{ Name: 'p' }])
  const ups = [{ rowId: s.rows[0], cells: { Name: 'q' } }]
  const first = done(batchUpdateKeyed(s.sheet, uid, ups, 'bz-1', 'rest'))
  await withSheetBusy(s.sheet, 'sorting', async () => {
    const gate = refuseChangesWhileBusy(V1_SHEET_BUSY_ALLOWED)
    const passes = (req: ReturnType<typeof request>) => {
      let next = false
      const res = response()
      gate(req as never, res as never, () => { next = true })
      return { next, res }
    }
    assert.equal(passes(request({ updates: [], idempotency_key: 'bz-1' }, {}, s.sheet)).next, true)
    assert.equal(passes(request({ updates: [] }, { 'idempotency-key': 'bz-1' }, s.sheet)).next, true)
    const plain = passes(request({ updates: [] }, {}, s.sheet))
    assert.equal(plain.next, false)
    assert.deepEqual([plain.res.code, plain.res.body], [409, { error: busyMessage('sorting'), busy: true }])
    assert.deepEqual(batchUpdateKeyed(s.sheet, uid, ups, 'bz-1', 'rest'), { ...first, replayed: true })
    assert.deepEqual(batchUpdateKeyed(s.sheet, uid, ups, 'bz-2', 'rest'),
      { fail: 'busy', message: busyMessage('sorting') })
    let ran = 0
    const tool = refuseWhileSheetBusy('update_cells', async () => { ran++; return { content: [] } })
    await tool({ sheet_id: s.sheet, updates: [], idempotency_key: 'bz-1' })
    assert.equal(ran, 1, 'a keyed update_cells reaches the tool')
    const refused = await tool({ sheet_id: s.sheet, updates: [] })
    assert.equal(ran, 1)
    assert.match(JSON.stringify(refused), /This sheet is busy sorting/)
  })
  assert.equal(db.prepare('SELECT json_extract(data, \'$.Name\') FROM rows WHERE id = ?').pluck().get(s.rows[0]), 'q')
})

await ok('auto-dedupe\'s restore words are said for the surface asking, and never stored', async () => {
  const s = sheet([{ Email: 'a@x.io' }, { Email: 'b@x.io' }, { Email: 'c@x.io' }])
  assert.ok('ok' in setAutoDedupe(uid, s.sheet, { column: 'Email', match: 'email', keep: 'oldest' }))
  assert.equal(await maintainAutoDedupeSheet(s.sheet, uid, Date.now() + 10_000), 'ready')
  const mcpWords = /^restore_from_trash with trash_id \d+ and seqs/
  const restWords = /^POST \/api\/v1\/trash\/\d+\/restore/
  const words = (a: unknown) => (a as { auto_dedupe: { trash: { how_to_restore: string } } }).auto_dedupe.trash
    .how_to_restore
  const ap = done(appendRowsKeyed(s.sheet, uid, [{ Email: 'A@x.io' }], 'dd-ap', 'mcp'))
  assert.match(words(ap.ok.answer), mcpWords)
  const apRest = done(appendRowsKeyed(s.sheet, uid, [{ Email: 'A@x.io' }], 'dd-ap', 'rest'))
  assert.match(words(apRest.ok.answer), restWords)
  assert.deepEqual(done(appendRowsKeyed(s.sheet, uid, [{ Email: 'A@x.io' }], 'dd-ap', 'mcp')).ok.answer, ap.ok.answer)
  const up = done(patchRowKeyed(s.rows[1], uid, { Email: 'a@x.io' }, undefined, 'dd-up', 'rest'))
  assert.match(words(up.ok), restWords)
  assert.match(words(done(patchRowKeyed(s.rows[1], uid, { Email: 'a@x.io' }, undefined, 'dd-up', 'mcp')).ok), mcpWords)
  const bt = done(batchUpdateKeyed(s.sheet, uid, [{ rowId: s.rows[2], cells: { Email: 'a@x.io' } }], 'dd-bt', 'mcp'))
  assert.match(words(bt.ok), mcpWords)
  const btRest = done(batchUpdateKeyed(s.sheet, uid, [{ rowId: s.rows[2], cells: { Email: 'a@x.io' } }], 'dd-bt',
    'rest'))
  assert.match(words(btRest.ok), restWords)
  for (const key of ['dd-ap', 'dd-up', 'dd-bt']) {
    assert.match(stored(key), /"trash_id":\d+/, key)
    assert.doesNotMatch(stored(key), /how_to_restore|restore_from_trash|api\/v1\/trash/, key)
  }
})

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall row-write replay surface checks passed')
