import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test'
import { authedApi, getSheet, importCsv, makeAccessToken, seedSheet, BASE } from './helpers'
import { bearer } from './api-v1-run-helpers'
import { mcpClient, call, callError } from './helpers-mcp'
import { seedLeads } from './helpers-dedupe'

// Auto-dedupe through every way a row arrives that isn't the grid: a webhook
// delivery whose key is already there isn't kept (the delivery says so); REST
// append_rows, update_cells and a CSV import say which rows went, keep oldest
// and keep newest; the rows go to one trash batch a day that the trash lists by
// how; MCP set_auto_dedupe and get_sheet; turning it off.

const v1Sheet = async (v1: APIRequestContext, sheetId: string) =>
  (await (await v1.get(`/api/v1/sheets/${sheetId}`)).json()) as { auto_dedupe: any; row_count: number }

async function waitOn(v1: APIRequestContext, sheetId: string) {
  await expect.poll(async () => (await v1Sheet(v1, sheetId)).auto_dedupe?.state, { timeout: 20_000 }).toBe('on')
}
const emails = async (api: APIRequestContext, sheetId: string): Promise<string[]> =>
  (await getSheet(api, sheetId)).data.rows.map((r: any) => r.data.Email ?? '')

test('auto-dedupe: a webhook delivery whose key is already there is not kept', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 1)
  const created = await api.post(`/api/sheets/${sheetId}/webhook`, { data: { name: 'leads' } })
  expect(created.status()).toBe(201)
  const url: string = (await created.json()).source.url
  expect((await api.post(`/api/sheets/${sheetId}/webhook/mappings`,
    { data: { jsonPath: '$.email', columnName: 'Email' } })).ok()).toBeTruthy()
  const on = await api.put(`/api/sheets/${sheetId}/auto-dedupe`, { data: { column: 'Email', match: 'email' } })
  expect(on.status()).toBe(200)
  expect((await on.json()).autoDedupe).toMatchObject({ column: 'Email', match: 'email', keep: 'oldest' })

  const anon = await pwRequest.newContext()
  const send = (email: string) => anon.post(url.startsWith('/') ? `${BASE}${url}` : url,
    { headers: { 'Content-Type': 'application/json' }, data: { email } })
  const first = await send('lead@acme.com')
  expect(first.status()).toBe(202)
  expect(await first.json()).toEqual({ ok: true })
  // The sender can't tell (the URL never says what the sheet holds); the delivery log can.
  const again = await send('  LEAD@acme.com ')
  expect(again.status()).toBe(202)
  expect(await again.json()).toEqual({ ok: true })
  expect(await (await send('other@acme.com')).json()).toEqual({ ok: true })
  await anon.dispose()

  expect((await emails(api, sheetId)).filter(Boolean)).toEqual(['lead@acme.com', 'other@acme.com'])
  const deliveries = await (await api.get(`/api/sheets/${sheetId}/webhook-deliveries`)).json()
  const statuses = (deliveries.deliveries ?? deliveries).map((d: any) => d.status)
  expect(statuses.filter((s: string) => s === 'duplicate')).toHaveLength(1)
  const trash = await (await api.get(`/api/trash?how=auto_dedupe&sheet_id=${sheetId}`)).json()
  expect(trash.items).toHaveLength(1)
  expect(trash.items[0]).toMatchObject({ how: 'auto_dedupe', rows: 1 })
})

test('auto-dedupe over REST: append, update, import, keep newest, the trash, off', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { sheetId } = await seedLeads(api)
  const v1 = await bearer(await makeAccessToken(api, ['read', 'write'], 'e2e auto-dedupe'))
  const url = `/api/v1/sheets/${sheetId}/auto-dedupe`

  expect((await v1.put(url, { data: { keep: 'oldest' } })).status()).toBe(400) // no column yet
  expect((await v1.put(url, { data: { column: 'Nope' } })).status()).toBe(400)
  expect((await v1.put(url, { data: { column: 'Email', what: 1 } })).status()).toBe(400)
  const on = await v1.put(url, { data: { column: 'Email', match: 'email' } })
  expect(on.status()).toBe(200)
  await waitOn(v1, sheetId)
  // jo@acme.com three times and pat@beta.io twice were there before: left as they were.
  expect((await v1Sheet(v1, sheetId)).auto_dedupe).toMatchObject({ shared_rows: 3, removed_rows: 0 })

  const appended = await v1.post(`/api/v1/sheets/${sheetId}/rows`, { data: { rows: [
    { data: { Email: 'JO@acme.com', Name: 'again' } }, { data: { Email: 'new@x.io' } },
    { data: { Email: 'new@x.io', Name: 'twice' } }, { data: { Email: '' } },
  ] } })
  expect(appended.status()).toBe(201)
  const a = await appended.json()
  // rows[i] is still the i-th row sent; the ones not kept say so.
  expect(a.rows.map((r: any) => r.kept !== false)).toEqual([false, true, false, true])
  expect(a.auto_dedupe).toMatchObject({ column: 'Email', keep: 'oldest', not_kept_count: 2, replaced_count: 0 })
  expect(a.auto_dedupe.trash.seqs).toHaveLength(2)
  expect(a.auto_dedupe.trash.how_to_restore).toContain(`/api/v1/trash/${a.auto_dedupe.trash.trash_id}/restore`)

  // An edit giving an older row a key a newer row has: the older row stays (keep oldest).
  const rows = (await getSheet(api, sheetId)).data.rows as Array<{ rowIndex: number; data: any }>
  const gil = (await (await v1.get(`/api/v1/sheets/${sheetId}/rows?limit=100`)).json()).rows
    .find((r: any) => r.data.Name === 'Gil')
  expect(rows.length).toBe(11)
  const patched = await v1.patch(`/api/v1/rows/${gil.id}`, { data: { data: { Email: 'new@x.io' } } })
  expect(patched.status()).toBe(200)
  expect((await patched.json()).auto_dedupe).toMatchObject({ not_kept_count: 0, replaced_count: 1 })

  // Keep newest: a new row replaces the older one; a CSV import's own repeat too.
  expect((await v1.put(url, { data: { keep: 'newest' } })).status()).toBe(200)
  const csv = await importCsv(api, sheetId, 'Email,Name\npat@beta.io,from csv\nzed@x.io,z1\nzed@x.io,z2\n')
  expect(csv.status()).toBe(200)
  const imported = await csv.json()
  // pat@beta.io's two older rows, and the first zed@x.io (one of the file's own).
  expect(imported.autoDedupe).toMatchObject({ column: 'Email', keep: 'newest', left: false, removed: 3, notKept: 1 })
  const left = await emails(api, sheetId)
  expect(left.filter(e => e.toLowerCase().trim() === 'pat@beta.io')).toHaveLength(1)
  expect(left.filter(e => e === 'zed@x.io')).toHaveLength(1)

  const trash = await (await v1.get(`/api/v1/trash?how=auto_dedupe&sheet_id=${sheetId}`)).json()
  expect(trash.items).toHaveLength(1)
  expect(trash.items[0].rows).toBe(6)
  expect((await v1Sheet(v1, sheetId)).auto_dedupe.removed_rows).toBe(6)

  expect((await v1.delete(url)).status()).toBe(200)
  expect((await v1Sheet(v1, sheetId)).auto_dedupe).toBeNull()
  const kept = await (await v1.post(`/api/v1/sheets/${sheetId}/rows`,
    { data: { rows: [{ data: { Email: 'zed@x.io' } }] } })).json()
  expect(kept.rows).toHaveLength(1)
  expect(kept.auto_dedupe).toBeUndefined()
})

test('auto-dedupe over MCP: set_auto_dedupe, get_sheet, append_rows, list_trash', async () => {
  const api = await authedApi()
  const { sheetId } = await seedLeads(api)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write'], 'e2e auto-dedupe mcp'), 'e2e-ad')
  const tool = (await client.listTools()).tools.find(t => t.name === 'set_auto_dedupe')
  expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })

  expect(await callError(client, 'set_auto_dedupe', { sheet_id: sheetId, off: true, keep: 'oldest' }))
    .toContain('off: true takes no other field')
  const on = await call(client, 'set_auto_dedupe', { sheet_id: sheetId, column: 'Website', match: 'domain' })
  expect(on.auto_dedupe).toMatchObject({ column: 'Website', match: 'domain', keep: 'oldest' })
  await expect.poll(async () => (await call(client, 'get_sheet', { sheet_id: sheetId })).auto_dedupe?.state,
    { timeout: 20_000 }).toBe('on')

  const out = await call(client, 'append_rows', { sheet_id: sheetId, rows: [
    { Website: 'https://beta.io/pricing' }, { Website: 'brand-new.dev' },
  ] })
  expect(out.rows.map((r: any) => r.kept !== false)).toEqual([false, true])
  expect(out.auto_dedupe).toMatchObject({ column: 'Website', not_kept_count: 1 })
  expect(out.auto_dedupe.trash.how_to_restore).toContain('restore_from_trash with trash_id')
  const listed = await call(client, 'list_trash', { how: 'auto_dedupe', sheet_id: sheetId })
  expect(listed.items).toHaveLength(1)
  const back = await call(client, 'restore_from_trash',
    { trash_id: out.auto_dedupe.trash.trash_id, seqs: out.auto_dedupe.trash.seqs })
  expect(back.rows).toBe(1)
  // A restored row stays, even though beta.io is there twice now.
  expect((await call(client, 'get_sheet', { sheet_id: sheetId })).row_count).toBe(11)
  expect((await call(client, 'set_auto_dedupe', { sheet_id: sheetId, off: true })).auto_dedupe).toBeNull()
})
