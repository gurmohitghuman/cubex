// Row and column writes against another connection committing between their
// first read and their first write (write-lock-kit.ts). Each takes the write
// lock first (.immediate()), so the other writer waits for it instead of the
// call failing with SQLITE_BUSY_SNAPSHOT ("database is locked"): append_rows,
// delete_rows, a column rename's switch, a duplicate removal's chunks, a new
// webhook's column, the keys a pasted cURL command saves, the column
// registry's repair (which, failed, left the columns unlisted until a restart),
// the grid's row delete (which answered 500) and first-run setup.
import assert from 'node:assert/strict'
import rowsMod from '../../server/src/services/rows-write'
import renameMod from '../../server/src/services/column-rename'
import dedupeMod from '../../server/src/services/dedupe-remove'
import webhookMod from '../../server/src/lib/webhook-service'
import keysMod from '../../server/src/services/saved-keys'
import repairMod from '../../server/src/lib/column-repair'
import mutateMod from '../../server/src/routes/sheets-rows-mutate'
import accountMod from '../../server/src/services/account'
import { attempt, fixture, rivalKit } from './write-lock-kit'
const { appendRows, deleteRowsByIds } = rowsMod as typeof import('../../server/src/services/rows-write')
const { renameSheetColumn } = renameMod as typeof import('../../server/src/services/column-rename')
const { removeDuplicates } = dedupeMod as typeof import('../../server/src/services/dedupe-remove')
const { createSourceWithColumn } = webhookMod as typeof import('../../server/src/lib/webhook-service')
const { saveImportedKeys } = keysMod as typeof import('../../server/src/services/saved-keys')
const { scheduleColumnRepair } = repairMod as typeof import('../../server/src/lib/column-repair')
const { createAccount } = accountMod as typeof import('../../server/src/services/account')
type Handle = (req: object, res: object) => void
type Layer = { route?: { path: string; stack: Array<{ handle: Handle }> } }
// The grid's route itself, past its session check (the router's first layer).
const bulkDelete = ((mutateMod as unknown as { default: { stack: Layer[] } }).default.stack
  .find(l => l.route?.path === '/:id/rows/bulk-delete')!).route!.stack[0].handle

const { db, uid, ok, done, sheet, cells, order, idle } = fixture('write lock: rows')
const rival = await rivalKit()
const emails = (...list: string[]) => list.map(Email => ({ Email }))
const ids = (s: string) => db.prepare('SELECT id FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
  .all(s) as string[]
const threw = (out: object) => ('threw' in out ? `failed with ${(out as { threw: string }).threw}` : '')

await ok("append_rows meeting another connection's commit adds its rows", async () => {
  const S = sheet(['Email'], emails('a@x.com'))
  const shot = rival.arm({ inTx: true })
  const out = await attempt(() => appendRows(S, uid, emails('b@x.com', 'c@x.com')))
  await rival.settled()
  assert.ok('value' in out && 'ok' in out.value, `append_rows ${threw(out)}`)
  assert.equal(shot.outcome, 'blocked', 'it held the write lock from its start')
  assert.deepEqual(cells(S, 'Email'), ['a@x.com', 'b@x.com', 'c@x.com'])
})

await ok("delete_rows meeting another connection's commit deletes its rows", async () => {
  const S = sheet(['Email'], emails('a@x.com', 'b@x.com', 'c@x.com'))
  const shot = rival.arm({ inTx: true })
  const out = await attempt(() => deleteRowsByIds(S, uid, ids(S).slice(0, 2)))
  await rival.settled()
  assert.ok('value' in out && 'ok' in out.value, `delete_rows ${threw(out)}`)
  assert.equal(shot.outcome, 'blocked', 'it held the write lock from its start')
  assert.equal(out.value.ok.deleted, 2)
  assert.deepEqual(cells(S, 'Email'), ['c@x.com'])
})

await ok("a column rename meeting another connection's commit renames", async () => {
  const S = sheet(['Email', 'Name'], emails('a@x.com', 'b@x.com'))
  const shot = rival.arm({ inTx: true, sql: /^SELECT column_order, empty_filter, column_filters FROM sheets/ })
  const out = await attempt(() => renameSheetColumn(S, uid, 'Email', 'Mail'))
  await idle(S)
  await rival.settled()
  assert.ok('value' in out && 'ok' in out.value, `the rename ${threw(out)}: ${JSON.stringify(out)}`)
  assert.equal(shot.outcome, 'blocked', 'its switch held the write lock from its start')
  assert.deepEqual(order(S), ['Mail', 'Name'])
  assert.deepEqual(cells(S, 'Mail'), ['a@x.com', 'b@x.com'])
})

await ok("removing duplicates meeting another connection's commit removes them", async () => {
  const S = sheet(['Email'], emails('a@x.com', 'A@x.com', 'b@x.com', 'a@X.com'))
  const shot = rival.arm({ inTx: true, sql: /^SELECT rowid FROM rows WHERE rowid IN \(SELECT value FROM json_each/ })
  const out = await attempt(() => removeDuplicates(uid, S, { columns: [{ column: 'Email', match: 'email' }] }))
  await idle(S)
  await rival.settled()
  assert.ok('value' in out && 'ok' in out.value, `the removal ${threw(out)}: ${JSON.stringify(out)}`)
  assert.equal(shot.outcome, 'blocked', 'its chunk held the write lock from its start')
  assert.equal(out.value.ok.removed, 2)
  assert.deepEqual(cells(S, 'Email'), ['a@x.com', 'b@x.com'])
})

await ok("a new webhook meeting another connection's commit gets its column", async () => {
  const S = sheet(['Email'], emails('a@x.com'))
  const shot = rival.arm({ inTx: true })
  const out = await attempt(() => createSourceWithColumn(S, uid, 'Signups'))
  await rival.settled()
  assert.ok('value' in out, `the webhook ${threw(out)}`)
  assert.equal(shot.outcome, 'blocked', 'it held the write lock from its start')
  assert.deepEqual(order(S), ['Email', out.value.source.raw_column_name])
})

await ok("saving a pasted cURL command's keys meeting another connection's commit saves them", async () => {
  const shot = rival.arm({ inTx: true })
  const out = await attempt(() => saveImportedKeys(uid, [], [
    { name: 'SERVICE_TOKEN', value: 'v-123', key_type: 'bearer', description: '' },
  ]))
  await rival.settled()
  assert.ok('value' in out && 'ok' in out.value, `saving the keys ${threw(out)}`)
  assert.equal(shot.outcome, 'blocked', 'it held the write lock from its start')
  assert.equal(db.prepare("SELECT COUNT(*) FROM api_keys WHERE name = 'SERVICE_TOKEN'").pluck().get(), 1)
})

await ok("the column registry's repair meeting another connection's commit lists the column", async () => {
  const S = sheet(['Email'], [{ Email: 'a@x.com', Ghost: 'g' }])
  const shot = rival.arm({ inTx: true })
  scheduleColumnRepair(S, uid)
  const until = Date.now() + 2_000
  while (!order(S).includes('Ghost') && Date.now() < until) await new Promise(r => setTimeout(r, 5))
  rival.disarm()
  await rival.settled()
  assert.deepEqual(order(S), ['Email', 'Ghost'], 'the repair went through')
  assert.equal(shot.outcome, 'blocked', 'it held the write lock from its start')
})

await ok("deleting rows in the grid meeting another connection's commit deletes them", async () => {
  const S = sheet(['Email'], emails('a@x.com', 'b@x.com', 'c@x.com'))
  const rowGeneration = db.prepare('SELECT row_generation FROM sheets WHERE id = ?').pluck().get(S)
  const res = { code: 200, body: null as unknown,
    status(c: number) { this.code = c; return this }, json(b: unknown) { this.body = b; return this } }
  const shot = rival.arm({ inTx: true })
  bulkDelete({ params: { id: S }, body: { rowIndices: [0, 2], rowGeneration }, userId: uid }, res)
  await rival.settled()
  assert.equal(res.code, 200, `the delete answered ${res.code} ${JSON.stringify(res.body)}`)
  assert.equal(shot.outcome, 'blocked', 'it held the write lock from its start')
  assert.deepEqual(cells(S, 'Email'), ['b@x.com'])
})

// Last: it needs a fresh install, so the account (and all of the above) goes.
await ok("first-run setup meeting another connection's commit creates the account", async () => {
  db.prepare('DELETE FROM users').run()
  const shot = rival.arm({ inTx: true })
  const out = await attempt(() => createAccount('not-a-real-hash'))
  await rival.settled()
  assert.ok('value' in out && typeof out.value === 'string', `setup ${threw(out)}`)
  assert.equal(shot.outcome, 'blocked', 'it held the write lock from its start')
  assert.equal(db.prepare('SELECT COUNT(*) FROM users').pluck().get(), 1)
})

await rival.stop()
done()
