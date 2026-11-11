// A deleted column through the routes a token uses (migration 054). An HTTP API column whose request reads a
// saved key needs the 'secrets' scope to come back: without it REST POST /trash/:id/restore answers 403, POST
// /trash/restore answers 200 with that item failed as forbidden, and MCP restore_from_trash gives the same in its
// results; each time the item stays kept, the column stays out of the sheet and no HTTP run is made. With
// 'secrets' it comes back, set up. The delete answers its trash with state "kept" on both surfaces, and the
// app's as before ({ id, days }). The test server keeps a connection open as long as the real one does.
import assert from 'node:assert/strict'
import keysMod from '../../server/src/services/saved-keys'
import writeMod from '../../server/src/services/setup-version-write'
import columnsMod from '../../server/src/lib/sheet-columns'
import { columnTrashKit } from './column-trash-kit'
import { trashSurfaces } from './column-trash-surfaces'
const { createSavedKey } = keysMod as typeof import('../../server/src/services/saved-keys')
const { writeHttpSetup } = writeMod as typeof import('../../server/src/services/setup-version-write')
const { appendColumnsToOrder } = columnsMod as typeof import('../../server/src/lib/sheet-columns')
const k = columnTrashKit('column-trash-routes')
const { db, uid, ok, done, idle, sheet, order, item } = k
console.error = () => {}

const WORDS = "\"Sync\": A request it puts back reads saved API keys: restoring it needs the 'secrets' scope."
const without = await trashSurfaces(uid, 'read,write,run')
const withSecrets = await trashSurfaces(uid, 'read,write,run,secrets')
assert.ok('ok' in createSavedKey(uid, { name: 'Crm', key_type: 'custom', key_value: 'k-123', description: null }))

// A sheet with an HTTP column Sync whose header reads the saved key, deleted to the trash over REST.
async function syncInTrash() {
  const sid = sheet(['Email'], [{ Email: 'a@x.co' }, { Email: 'b@y.io' }])
  const config = { requestConfig: { method: 'GET', url: 'https://api.example.test/p?e={{Email}}',
    headers: { Authorization: 'Bearer {{Crm}}' } }, responseMapping: [] }
  db.transaction(() => {
    appendColumnsToOrder(sid, uid, ['Sync'])
    writeHttpSetup(sid, uid, 'Sync', { kind: 'http', mode: 'http', config, allowSecrets: 1, destSheetId: null,
      extracted: [] }, order(sid), true)
  })()
  db.prepare(`UPDATE rows SET data = json_set(data, '$.Sync', '✅ Success') WHERE sheet_id = ?`).run(sid)
  const del = await without.rest('DELETE', `/sheets/${sid}/columns/Sync`)
  assert.equal(del.status, 200, JSON.stringify(del.body))
  assert.equal(del.body.trash.state, 'kept')
  assert.equal(del.body.trash.note, undefined)
  await idle(sid)
  return { sid, id: del.body.trash.trash_id as number }
}
const httpRuns = (sid: string) => db.prepare('SELECT COUNT(*) FROM http_runs WHERE sheet_id = ?').pluck().get(sid)
const untouched = (sid: string, id: number, runs: unknown) => {
  assert.equal(item(id)!.state, 'kept', 'the item stays kept')
  assert.deepEqual(order(sid), ['Email'], 'the column stays out of the sheet')
  assert.equal(httpRuns(sid), runs, 'no HTTP run is made')
}

await ok("REST: a token without 'secrets' gets 403 from POST /trash/:id/restore; with it, the column is back",
  async () => {
    const { sid, id } = await syncInTrash()
    const runs = httpRuns(sid)
    const refused = await without.rest('POST', `/trash/${id}/restore`)
    assert.deepEqual([refused.status, refused.body], [403, { error: WORDS }])
    untouched(sid, id, runs)
    const back = await withSecrets.rest('POST', `/trash/${id}/restore`)
    assert.equal(back.status, 200, JSON.stringify(back.body))
    assert.deepEqual([back.body.name, back.body.setup.kind, back.body.setup.restored], ['Sync', 'http', true])
    assert.deepEqual(order(sid), ['Email', 'Sync'])
    assert.equal(item(id), undefined)
  })

await ok("REST: POST /trash/restore answers 200 with the item failed as forbidden, the others still go", async () => {
  const { sid, id } = await syncInTrash()
  const plain = sheet(['A', 'B'], [{ A: 1, B: 2 }])
  const other = (await without.rest('DELETE', `/sheets/${plain}/columns/B`)).body.trash.trash_id as number
  const runs = httpRuns(sid)
  const out = await without.rest('POST', '/trash/restore', { trash_ids: [id, other] })
  assert.equal(out.status, 200, JSON.stringify(out.body))
  const mine = out.body.results.find((r: any) => r.trash_id === id)
  assert.deepEqual([mine.fail, mine.error, mine.restored], ['forbidden', WORDS, undefined])
  assert.ok(out.body.results.find((r: any) => r.trash_id === other).restored, 'the other item came back')
  untouched(sid, id, runs)
})

await ok("MCP: restore_from_trash without 'secrets' fails that item as forbidden; with it, it comes back",
  async () => {
    const { sid, id } = await syncInTrash()
    const runs = httpRuns(sid)
    const out = await without.call('restore_from_trash', { trash_ids: [id] })
    assert.equal(out.isError, false)
    assert.deepEqual(out.body.results, [{ trash_id: id, error: WORDS, fail: 'forbidden' }])
    untouched(sid, id, runs)
    const back = await withSecrets.call('restore_from_trash', { trash_ids: [id] })
    assert.equal(back.body.results[0].restored.setup.restored, true, JSON.stringify(back.body))
    assert.deepEqual(order(sid), ['Email', 'Sync'])
    const del = await without.call('delete_column', { sheet_id: sid, column: 'Email' })
    assert.deepEqual([del.body.deleted, del.body.trash.state], [true, 'kept'])
    const viaApp = await without.app('DELETE', `/sheets/${sheet(['A', 'B'], [{ A: 1, B: 2 }])}/columns/B`)
    assert.deepEqual(viaApp.body, { message: 'Column deleted successfully',
      trash: { id: viaApp.body.trash.id, days: 30 } }, 'in time: no moving')
  })

// The test server takes the real server's timeouts (lib/server-timeouts.ts). Under Node's default keep-alive it
// closes an idle connection after 6 s, and a slow machine building a big sheet can hold the loop that long
// between two requests: the next one then fails ("fetch failed", ECONNRESET), as one did on a Windows run.
await ok("a request after the loop was held 7 s in one turn gets its answer: the real server's keep-alive",
  async () => {
    assert.equal((await without.rest('GET', '/trash?limit=1')).status, 200)
    await new Promise(r => setTimeout(r, 0))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 7_000)
    assert.equal((await without.rest('GET', '/trash?limit=1')).status, 200)
  })

await without.close()
await withSecrets.close()
done()
