import { test, expect } from '@playwright/test'
import { authedApi, seedSheet } from './helpers'
import { JSON_URL, makeToken, bearer, httpConfig, waitForTerminal } from './api-v1-run-helpers'
import { mcpClient, call, callError } from './helpers-mcp'

// Row writes with an idempotency key, over /api/v1 and MCP (services/rows-write-keyed.ts):
// a retry replays the first answer and writes nothing, on either surface; the
// same key with other arguments is a 409 (or the tool's error) in the words run
// starts use; no key is as before. And list_saved_keys / GET /api/v1/saved-keys:
// a read token sees key names and where they're used, never a value.

const CONFLICT = 'Idempotency key was already used with different arguments.'

test('row writes with an idempotency key replay over REST and MCP; other arguments are refused', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const token = await makeToken(api, ['read', 'write'], 'e2e idempotent writes')
  const v1 = await bearer(token)
  const mcp = await mcpClient(token, 'e2e-idempotent-writes')
  const count = async () => {
    const res = await v1.get(`/api/v1/sheets/${sheetId}/rows?limit=500`)
    return (await res.json()).rows.length as number
  }
  const append = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    v1.post(`/api/v1/sheets/${sheetId}/rows`, { data: body, headers })

  // REST append: header key; the retry (the key in the body this time, cells' keys reordered) replays.
  const rows = [{ data: { val: 'a' } }, { data: { val: 'b' } }]
  const first = await append({ rows }, { 'Idempotency-Key': 'e2e-ap-1' })
  expect(first.status()).toBe(201)
  const firstBody = await first.json()
  expect(firstBody.replayed).toBe(false)
  expect(firstBody.rows).toHaveLength(2)
  const again = await append({ rows, idempotency_key: 'e2e-ap-1' })
  expect(again.status()).toBe(200)
  const againBody = await again.json()
  expect(againBody).toEqual({ rows: firstBody.rows, replayed: true })
  expect(await count()).toBe(4)

  // Other rows under the key: refused, nothing written. MCP gets the same words.
  const clash = await append({ rows: [{ data: { val: 'c' } }] }, { 'Idempotency-Key': 'e2e-ap-1' })
  expect(clash.status()).toBe(409)
  expect(await clash.json()).toEqual({ error: CONFLICT })
  expect(await callError(mcp, 'append_rows', { sheet_id: sheetId, rows: [{ val: 'c' }], idempotency_key: 'e2e-ap-1' }))
    .toBe(CONFLICT)
  // One key namespace across surfaces: MCP with the same rows replays the REST call.
  const viaMcp = await call(mcp, 'append_rows', {
    sheet_id: sheetId, rows: [{ val: 'a' }, { val: 'b' }], idempotency_key: 'e2e-ap-1',
  })
  expect(viaMcp).toEqual({ rows: firstBody.rows, replayed: true })
  expect(await count()).toBe(4)

  // One row: MCP first (no sheet_id), MCP again with the row's sheet_id, then REST PATCH: one write.
  const rowId = firstBody.rows[0].id
  const up = await call(mcp, 'update_cells', { row_id: rowId, data: { val: 'A1' }, idempotency_key: 'e2e-up-1' })
  expect(up.replayed).toBe(false)
  expect(up.data.val).toBe('A1')
  const upAgain = await call(mcp, 'update_cells', {
    row_id: rowId, sheet_id: sheetId, data: { val: 'A1' }, idempotency_key: 'e2e-up-1',
  })
  expect(upAgain).toEqual({ ...up, replayed: true })
  const patch = await v1.patch(`/api/v1/rows/${rowId}`, { data: { data: { val: 'A1' }, idempotency_key: 'e2e-up-1' } })
  expect(patch.status()).toBe(200)
  expect((await patch.json()).replayed).toBe(true)
  const patchClash = await v1.patch(`/api/v1/rows/${rowId}`, {
    data: { data: { val: 'other' } }, headers: { 'Idempotency-Key': 'e2e-up-1' },
  })
  expect(patchClash.status()).toBe(409)
  expect((await patchClash.json()).error).toBe(CONFLICT)

  // Many rows: REST first, REST again in another order, then MCP: one write.
  const updates = firstBody.rows.map((r: { id: string }, i: number) => ({ row_id: r.id, data: { val: `m${i}` } }))
  const batch = await v1.post(`/api/v1/sheets/${sheetId}/rows/update`, {
    data: { updates, idempotency_key: 'e2e-bt-1' },
  })
  expect(await batch.json()).toEqual({ updated: 2, replayed: false })
  const batchAgain = await v1.post(`/api/v1/sheets/${sheetId}/rows/update`, {
    data: { updates: [...updates].reverse() }, headers: { 'Idempotency-Key': 'e2e-bt-1' },
  })
  expect(await batchAgain.json()).toEqual({ updated: 2, replayed: true })
  expect(await call(mcp, 'update_cells', { sheet_id: sheetId, updates, idempotency_key: 'e2e-bt-1' }))
    .toEqual({ updated: 2, replayed: true })

  // No key: each call writes, and the answer is as before (no replayed field). A bad key is a 400.
  const plain1 = await (await append({ rows: [{ data: { val: 'p' } }] })).json()
  const plain2 = await (await append({ rows: [{ data: { val: 'p' } }] })).json()
  expect(plain1.replayed).toBeUndefined()
  expect(plain1.rows[0].id).not.toBe(plain2.rows[0].id)
  expect(await count()).toBe(6)
  expect((await append({ rows, idempotency_key: '' })).status()).toBe(400)

  await mcp.close()
  await v1.dispose()
})

test('a read token lists saved key names and where they are used, never a value', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 1)
  const name = 'e2e_listed_key'
  const value = ['zQ8vW2', 'kP5nR9', 'tY3mL7'].join('')  // built from pieces: no key-shaped string in the source
  const keys = await (await api.get('/api/settings/api-keys')).json()
  for (const k of keys) if (k.name === name) await api.delete(`/api/settings/api-keys/${k.id}`)
  const made = await api.post('/api/settings/api-keys', { data: { name, key_type: 'api_key', key_value: value } })
  expect(made.ok()).toBeTruthy()
  const keyId = (await made.json()).id
  try {
    // A column whose request reads the key (starting it needs 'secrets', as before).
    const secrets = await bearer(await makeToken(api, ['read', 'write', 'run', 'secrets'], 'e2e keys secrets'))
    const start = await secrets.post(`/api/v1/sheets/${sheetId}/http-runs`, {
      data: { config: httpConfig(JSON_URL, 'Title', { 'X-Api-Key': `{{${name}}}` }), master_column_name: 'Lookup' },
    })
    expect(start.status()).toBe(202)
    await waitForTerminal(secrets, `/api/v1/http-runs/${(await start.json()).run_id}`)

    const readToken = await makeToken(api, ['read'], 'e2e keys read')
    const v1 = await bearer(readToken)
    const res = await v1.get('/api/v1/saved-keys')
    expect(res.status()).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(value)
    expect(text).not.toContain(value.slice(0, 6))
    const listed = JSON.parse(text).keys.find((k: { name: string }) => k.name === name)
    expect(listed.used_in).toEqual([expect.objectContaining({ sheet_id: sheetId, column: 'Lookup', kind: 'http' })])
    expect(listed.used_in_count).toBe(1)
    expect(Object.keys(listed).sort()).toEqual(
      ['created_at', 'name', 'setups', 'setups_count', 'updated_at', 'used_in', 'used_in_count'])
    expect((await v1.get(`/api/v1/saved-keys?name=${name.toUpperCase()}`)).status()).toBe(200)
    expect((await v1.get('/api/v1/saved-keys?name=no_such_key')).status()).toBe(404)

    const mcp = await mcpClient(readToken, 'e2e-saved-keys')
    const viaMcp = await call(mcp, 'list_saved_keys', { name })
    expect(JSON.stringify(viaMcp)).not.toContain(value)
    expect(viaMcp.keys).toEqual([listed])
    await mcp.close()

    // Using the key in a new request still needs 'secrets'.
    const run = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e keys run'))
    const refused = await run.post(`/api/v1/sheets/${sheetId}/http-runs`, {
      data: { config: httpConfig(JSON_URL, 'T2', { 'X-Api-Key': `{{${name}}}` }), master_column_name: 'Other' },
    })
    expect(refused.status()).toBe(403)
    await Promise.all([v1.dispose(), secrets.dispose(), run.dispose()])
  } finally {
    await api.delete(`/api/settings/api-keys/${keyId}`)
  }
})
