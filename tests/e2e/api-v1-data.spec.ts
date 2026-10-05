import { test, expect, request as pwRequest, APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'

// /api/v1 data plane (design-doc Phase 1, step 2a): discovery, keyset-paged
// reads, append/patch/delete by STABLE row id, add-column, scope enforcement,
// and the data_version bump on every mutation.


// Delegates to helpers.makeAccessToken, which mints straight into the test DB.
async function makeToken(api: APIRequestContext, scopes: string[], name: string): Promise<string> {
  return makeAccessToken(api, scopes, name)
}

function bearer(token: string) {
  return pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  })
}

test('v1 data plane: discover → read → append → patch → delete, dv bumps', async () => {
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 3) // 'val' column, v0..v2
  const v1 = await bearer(await makeToken(api, ['read', 'write'], 'e2e v1 rw'))

  // Discovery: the seeded table + sheet are visible with a row count.
  const tables = await (await v1.get('/api/v1/tables')).json()
  const table = tables.tables.find((t: any) => t.id === tableId)
  expect(table).toBeTruthy()
  expect(table.sheets[0]).toMatchObject({ id: sheetId, row_count: 3 })

  // Sheet meta: ordered columns + count + data_version.
  const meta1 = await (await v1.get(`/api/v1/sheets/${sheetId}`)).json()
  expect(meta1.columns).toEqual(['val'])
  expect(meta1.row_count).toBe(3)
  const dv0 = meta1.data_version
  expect(typeof dv0).toBe('number')

  // Keyset paging: limit=2 → next_cursor, second page has the rest.
  const p1 = await (await v1.get(`/api/v1/sheets/${sheetId}/rows?limit=2`)).json()
  expect(p1.rows).toHaveLength(2)
  expect(p1.rows[0]).toMatchObject({ index: 0, data: { val: 'v0' } })
  expect(typeof p1.rows[0].id).toBe('string')
  expect(p1.next_cursor).toBe(p1.rows[1].index)
  const p2 = await (await v1.get(`/api/v1/sheets/${sheetId}/rows?limit=2&cursor=${p1.next_cursor}`)).json()
  expect(p2.rows).toHaveLength(1)
  expect(p2.rows[0].data.val).toBe('v2')

  // Append two rows; ids come back; dv bumped; unknown column rejected.
  const app = await v1.post(`/api/v1/sheets/${sheetId}/rows`, {
    data: { rows: [{ data: { val: 'v3' } }, { data: { val: 44 } }] }, // number coerces
  })
  expect(app.status()).toBe(201)
  const created = (await app.json()).rows
  expect(created).toHaveLength(2)
  const meta2 = await (await v1.get(`/api/v1/sheets/${sheetId}`)).json()
  expect(meta2.row_count).toBe(5)
  expect(meta2.data_version).toBeGreaterThan(dv0)
  const badApp = await v1.post(`/api/v1/sheets/${sheetId}/rows`, {
    data: { rows: [{ data: { nope: 'x' } }] },
  })
  expect(badApp.status()).toBe(400)
  expect((await badApp.json()).unknownColumns).toEqual(['nope'])

  // PATCH by stable id: edit, then null → '' clear; bogus id → 404.
  const rowId = created[0].id
  const patch = await v1.patch(`/api/v1/rows/${rowId}`, { data: { data: { val: 'EDITED' } } })
  expect(patch.status()).toBe(200)
  expect((await patch.json()).data.val).toBe('EDITED')
  const cleared = await (await v1.patch(`/api/v1/rows/${rowId}`, { data: { data: { val: null } } })).json()
  expect(cleared.data.val).toBe('')
  expect((await v1.patch(`/api/v1/rows/${crypto.randomUUID()}`, { data: { data: { val: 'x' } } })).status()).toBe(404)
  expect((await v1.patch(`/api/v1/rows/${rowId}`, { data: { data: { nope: 'x' } } })).status()).toBe(400)
  const meta3 = await (await v1.get(`/api/v1/sheets/${sheetId}`)).json()
  expect(meta3.data_version).toBeGreaterThan(meta2.data_version)

  // Bulk delete by ids (one real, one bogus → only the real one counts).
  const del = await v1.post(`/api/v1/sheets/${sheetId}/rows/delete`, {
    data: { row_ids: [created[1].id, crypto.randomUUID()] },
  })
  expect(del.status()).toBe(200)
  expect((await del.json()).deleted).toBe(1)
  const meta4 = await (await v1.get(`/api/v1/sheets/${sheetId}`)).json()
  expect(meta4.row_count).toBe(4)
  expect(meta4.data_version).toBeGreaterThan(meta3.data_version)

  await v1.dispose()
})

test('v1 columns: add, then write to it; collision 409', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const v1 = await bearer(await makeToken(api, ['read', 'write'], 'e2e v1 cols'))

  const add = await v1.post(`/api/v1/sheets/${sheetId}/columns`, { data: { name: 'Notes' } })
  expect(add.status()).toBe(201)
  expect((await add.json()).name).toBe('Notes')
  const meta = await (await v1.get(`/api/v1/sheets/${sheetId}`)).json()
  expect(meta.columns).toEqual(['val', 'Notes'])

  // Case-insensitive collision → 409; cap and validation piggyback on shared lib.
  expect((await v1.post(`/api/v1/sheets/${sheetId}/columns`, { data: { name: 'notes' } })).status()).toBe(409)

  // The new column is writable via append + patch.
  const app = await (await v1.post(`/api/v1/sheets/${sheetId}/rows`, {
    data: { rows: [{ data: { val: 'x', Notes: 'hello' } }] },
  })).json()
  const rows = await (await v1.get(`/api/v1/sheets/${sheetId}/rows?limit=100`)).json()
  const appended = rows.rows.find((r: any) => r.id === app.rows[0].id)
  expect(appended.data.Notes).toBe('hello')

  // A column literally named __proto__ round-trips (null-proto cells map —
  // on a plain object the prototype setter would silently swallow the write).
  expect((await v1.post(`/api/v1/sheets/${sheetId}/columns`, { data: { name: '__proto__' } })).status()).toBe(201)
  const pr = await v1.patch(`/api/v1/rows/${app.rows[0].id}`, {
    data: { data: { ['__proto__']: 'stored-as-cell' } },
  })
  expect(pr.status()).toBe(200)
  expect((await pr.json()).data['__proto__']).toBe('stored-as-cell')
  expect((await v1.delete(`/api/v1/sheets/${sheetId}/columns/${encodeURIComponent('__proto__')}`)).status()).toBe(200)

  // Rename via the shared cascade service: data moves to the new key; the old
  // key is gone; collision with an existing column → 409; unknown → 404.
  const ren = await v1.patch(`/api/v1/sheets/${sheetId}/columns/Notes`, { data: { name: 'Remarks' } })
  expect(ren.status()).toBe(200)
  expect((await ren.json()).name).toBe('Remarks')
  const afterRen = await (await v1.get(`/api/v1/sheets/${sheetId}/rows?limit=100`)).json()
  const renRow = afterRen.rows.find((r: any) => r.id === app.rows[0].id)
  expect(renRow.data.Remarks).toBe('hello')
  expect('Notes' in renRow.data).toBe(false)
  expect((await v1.patch(`/api/v1/sheets/${sheetId}/columns/Remarks`, { data: { name: 'VAL' } })).status()).toBe(409)
  expect((await v1.patch(`/api/v1/sheets/${sheetId}/columns/nope`, { data: { name: 'X' } })).status()).toBe(404)

  // Reorder: full set required; order reflects in sheet meta.
  expect((await v1.put(`/api/v1/sheets/${sheetId}/columns/order`, { data: { order: ['Remarks'] } })).status()).toBe(400)
  expect((await v1.put(`/api/v1/sheets/${sheetId}/columns/order`, { data: { order: ['Remarks', 'val'] } })).status()).toBe(200)
  expect((await (await v1.get(`/api/v1/sheets/${sheetId}`)).json()).columns).toEqual(['Remarks', 'val'])

  // Delete: cascade service; last-column guard.
  expect((await v1.delete(`/api/v1/sheets/${sheetId}/columns/Remarks`)).status()).toBe(200)
  const afterDel = await (await v1.get(`/api/v1/sheets/${sheetId}`)).json()
  expect(afterDel.columns).toEqual(['val'])
  expect((await v1.delete(`/api/v1/sheets/${sheetId}/columns/val`)).status()).toBe(400) // last column
  expect((await v1.delete(`/api/v1/sheets/${sheetId}/columns/ghost`)).status()).toBe(404)
  await v1.dispose()
})

test('v1 authz: a read-only token gets 403 on every mutation', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 1)

  // Read-only token: reads OK, every mutation 403 with the missing scope named.
  const ro = await bearer(await makeToken(api, ['read'], 'e2e v1 ro'))
  expect((await ro.get(`/api/v1/sheets/${sheetId}`)).status()).toBe(200)
  const write = await ro.post(`/api/v1/sheets/${sheetId}/rows`, { data: { rows: [{ data: { val: 'x' } }] } })
  expect(write.status()).toBe(403)
  expect((await write.json()).error).toContain("'write' scope")
  expect((await ro.post(`/api/v1/sheets/${sheetId}/columns`, { data: { name: 'X' } })).status()).toBe(403)
  await ro.dispose()
})
