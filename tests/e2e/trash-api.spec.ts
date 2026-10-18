import { test, expect, request as pwRequest } from '@playwright/test'
import { authedApi, BASE, importCsv, makeAccessToken, seedSheet } from './helpers'
import { call, callError, mcpClient } from './helpers-mcp'

// The trash over REST and MCP (services/trash-*.ts): delete_rows, a CSV
// replace, remove_duplicates and a deleted sheet answer with where they went
// and how to restore; list_trash finds them, restore_from_trash brings them
// back (a whole batch at their old places, or rows picked by a search); a
// deleted sheet's webhook stops taking deliveries until it is back; the
// sheet's history names the token that did each thing.

const rowsOf = async (v1: Awaited<ReturnType<typeof bearer>>, sheetId: string) =>
  (await (await v1.get(`/api/v1/sheets/${sheetId}/rows`, { params: { limit: 500 } })).json()).rows as
    Array<{ id: string; index: number; data: Record<string, string> }>
const bearer = (token: string) => pwRequest.newContext({
  baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` },
})

test('REST: deleted rows go to the trash and come back; history names the token', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 6)
  const v1 = await bearer(await makeAccessToken(api, ['read', 'write'], 'e2e trash rest'))
  const before = await rowsOf(v1, sheetId)

  const del = await v1.post(`/api/v1/sheets/${sheetId}/rows/delete`,
    { data: { row_ids: [before[1].id, before[4].id] } })
  expect(del.status()).toBe(200)
  const out = await del.json()
  expect(out.deleted).toBe(2)
  expect(out.trash).toMatchObject({ kept_days: 30, how_to_restore: expect.stringContaining('/api/v1/trash/') })
  const trashId = out.trash.trash_id as number

  const list = await (await v1.get('/api/v1/trash', { params: { kind: 'rows', q: 'e2e trash rest' } })).json()
  expect(list.items.map((i: { id: number }) => i.id)).toContain(trashId)
  const entry = list.items.find((i: { id: number }) => i.id === trashId)
  expect(entry).toMatchObject({ rows: 2, how: 'api', via: 'api', token_name: 'e2e trash rest' })
  expect(entry.by).toBe('the token "e2e trash rest" (the API)')

  const found = await (await v1.get(`/api/v1/trash/${trashId}/rows`, { params: { column: 'val', contains: 'V4' } }))
    .json()
  expect(found.rows.map((r: { row_id: string }) => r.row_id)).toEqual([before[4].id])
  const csv = await v1.get(`/api/v1/trash/${trashId}/csv`)
  expect(csv.headers()['content-type']).toContain('text/csv')
  expect((await csv.text()).split('\r\n')).toEqual(['"val"', '"v1"', '"v4"'])

  // One picked row, then the rest of the batch: both at their old places.
  const picked = await v1.post(`/api/v1/trash/${trashId}/restore`, { data: { seqs: [found.rows[0].seq] } })
  expect(picked.status(), await picked.text()).toBe(200)
  expect(await picked.json()).toMatchObject({ rows: 1, place: 'old', state: 'restored' })
  const rest = await v1.post('/api/v1/trash/restore', { data: { trash_ids: [trashId] } })
  expect((await rest.json()).results[0].restored).toMatchObject({ rows: 1, place: 'old' })
  expect(await rowsOf(v1, sheetId)).toEqual(before)
  expect((await v1.get(`/api/v1/trash/${trashId}`)).status()).toBe(404)

  const history = await (await v1.get(`/api/v1/sheets/${sheetId}/history`)).json()
  const lines = history.changes.map((c: { summary: string; by: string }) => `${c.summary} | ${c.by}`)
  expect(lines.slice(0, 3)).toEqual([
    'Restored 1 row to their old places | the token "e2e trash rest" (the API)',
    'Restored 1 row to their old places | the token "e2e trash rest" (the API)',
    'Deleted 2 rows | the token "e2e trash rest" (the API)',
  ])
  await v1.dispose()
})

test('a CSV replace keeps the old rows in the trash; a deleted sheet stops its webhook until restored',
  async () => {
    const api = await authedApi()
    const { tableId, sheetId } = await seedSheet(api, 3)
    expect((await importCsv(api, sheetId, 'name\nAda\nGrace\n', { replaceData: true })).ok()).toBeTruthy()
    const replaced = (await (await api.get('/api/trash', { params: { kind: 'rows' } })).json()).items
      .find((i: { sheet_id: string }) => i.sheet_id === sheetId)
    expect(replaced).toMatchObject({ how: 'import', rows: 3, by: 'the app', columns: ['val'] })

    const hook = await (await api.post(`/api/sheets/${sheetId}/webhook`, { data: { name: 'e2e hook' } })).json()
    const anon = await pwRequest.newContext()
    const deliver = () => anon.post(hook.source.url, { headers: { 'Content-Type': 'application/json' }, data: {} })
    expect((await deliver()).status()).toBe(202)
    // A second sheet, so the first can be deleted.
    await api.post(`/api/tables/${tableId}/sheets`, { data: { name: 'Other' } })
    const gone = await api.delete(`/api/tables/${tableId}/sheets/${sheetId}`)
    const trash = (await gone.json()).trash
    expect(trash).toMatchObject({ id: expect.any(Number), days: 30 })
    expect((await deliver()).status()).toBe(404)
    expect((await api.get(`/api/sheets/${sheetId}`)).status()).toBe(404)
    const restored = await (await api.post('/api/trash/restore', { data: { ids: [trash.id] } })).json()
    expect(restored.results[0].restored).toMatchObject({ kind: 'sheet', state: 'restored' })
    expect((await deliver()).status()).toBe(202)
    await anon.dispose()
  })

test('MCP: delete_rows, remove_duplicates and manage_sheet go to the trash; restore_from_trash brings them back',
  async () => {
    const api = await authedApi()
    const { tableId, sheetId } = await seedSheet(api, 4)
    const token = await makeAccessToken(api, ['read', 'write'], 'e2e trash mcp')
    const client = await mcpClient(token, 'e2e trash mcp')
    const rows = (await call(client, 'read_rows', { sheet_id: sheetId })).rows as Array<{ id: string }>

    const del = await call(client, 'delete_rows', { sheet_id: sheetId, row_ids: [rows[0].id] })
    expect(del.trash.how_to_restore).toContain('restore_from_trash')
    await call(client, 'update_cells', { row_id: rows[2].id, data: { val: 'v1' } })
    const dupes = await call(client, 'remove_duplicates', { sheet_id: sheetId, columns: ['val'], dry_run: false })
    expect(dupes.rows_removed).toBe(1)
    expect(dupes.trash.trash_id).toEqual(expect.any(Number))

    const listed = await call(client, 'list_trash', { sheet_id: sheetId })
    expect(listed.items.map((i: { how: string }) => i.how)).toEqual(['duplicates', 'api'])
    const inside = await call(client, 'list_trash', { trash_id: dupes.trash.trash_id })
    expect(inside.item.rows).toBe(1)
    expect(inside.rows[0].cells).toEqual({ val: 'v1' })

    await call(client, 'manage_sheet', { action: 'create', table_id: tableId, name: 'Spare' })
    const sheetGone = await call(client, 'manage_sheet', { action: 'delete', table_id: tableId, sheet_id: sheetId })
    expect(sheetGone.trash.trash_id).toEqual(expect.any(Number))
    expect(await callError(client, 'read_rows', { sheet_id: sheetId })).toMatch(/not found/i)
    // The rows wait for their sheet; restoring the sheet first lets them through.
    const blocked = await call(client, 'restore_from_trash', { trash_ids: [del.trash.trash_id] })
    expect(blocked.results[0].error).toMatch(/Restore the sheet first/)
    const back = await call(client, 'restore_from_trash',
      { trash_ids: [del.trash.trash_id, dupes.trash.trash_id, sheetGone.trash.trash_id] })
    expect(back.results.map((r: { restored?: { kind?: string } }) => r.restored?.kind ?? 'rows'))
      .toEqual(['sheet', 'rows', 'rows'])
    const after = (await call(client, 'read_rows', { sheet_id: sheetId })).rows as Array<{ id: string }>
    expect(after.map(r => r.id).sort()).toEqual(rows.map(r => r.id).sort())

    const history = await call(client, 'get_sheet_history', { sheet_id: sheetId })
    expect(history.changes.some((c: { action: string; by: string }) =>
      c.action === 'sheet_restored' && c.by === 'the token "e2e trash mcp" (MCP)')).toBeTruthy()
    await client.close()
  })
