import { test, expect, type APIRequestContext } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'

// Setups over MCP and /api/v1: a real chain (a formula, a clean column, an
// HTTP API column reading the formula, an AI column reading both, run with a
// fake OpenRouter key so every row fails for free) saved from one column with
// everything it reads; a preview saves nothing; names are unique; scopes;
// export carries keys by name only and imports again under "(2)"; delete.

const SEED = [{ Name: '  ada   lovelace ', Website: 'acme.com' }, { Name: 'grace hopper', Website: 'navy.mil' }]
const FAKE_KEY = 'sk-or-v1-invalid-e2e'

async function seedPeople(api: APIRequestContext): Promise<string> {
  const { sheetId } = await seedSheet(api, SEED.length)
  for (const c of ['Name', 'Website']) {
    expect((await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: c } })).ok()).toBeTruthy()
  }
  const updates = SEED.flatMap((r, i) =>
    Object.entries(r).map(([columnName, value]) => ({ rowIndex: i, columnName, value })))
  expect((await api.put(`/api/sheets/${sheetId}/data`, { data: { updates } })).ok()).toBeTruthy()
  return sheetId
}

async function waitRun(client: Client, type: 'ai' | 'http', runId: string) {
  await expect.poll(async () =>
    (await call(client, 'get_run_status', { run_type: type, run_id: runId, wait_seconds: 2 })).status,
  { timeout: 60_000 }).toMatch(/completed|failed/)
}

async function clearSetups(api: APIRequestContext) {
  for (const s of (await (await api.get('/api/setups')).json()).setups) await api.delete(`/api/setups/${s.id}`)
}

test('a chain saved as a setup over MCP and REST, exported and imported', async () => {
  test.setTimeout(180_000)
  const api = await authedApi()
  await clearSetups(api)
  const sheetId = await seedPeople(api)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'setups-e2e')
  const client = await mcpClient(token)

  await call(client, 'formula_column', { sheet_id: sheetId, column: 'Domain', formula: '{{Website}}?.split(".")[0]' })
  await call(client, 'clean_column', { sheet_id: sheetId, source_column: 'Name', cleaner: 'person_name',
    column: 'Clean name' })
  const http = await call(client, 'run_http_enrichment', {
    sheet_id: sheetId, url: 'https://jsonplaceholder.typicode.com/posts/1?d={{Domain}}', master_column_name: 'Lookup',
    response_mapping: [{ json_path: '$.id', column_name: 'Post id' }], run_if: '{{Domain}} is not empty',
  })
  await waitRun(client, 'http', http.run_id)
  expect((await api.put('/api/settings/openrouter-key', { data: { apiKey: FAKE_KEY } })).ok()).toBeTruthy()
  try {
    const ai = await call(client, 'run_ai_column', {
      sheet_id: sheetId, column_name: 'Fit', prompt: 'Is /clean_name at /domain a fit? Post /post_id.',
      model: 'deepseek/deepseek-v4-flash',
    })
    await waitRun(client, 'ai', ai.run_id)
  } finally {
    await api.delete('/api/settings/openrouter-key')
  }

  // A preview from the AI column brings everything it reads, each step after what it reads.
  const preview = await call(client, 'save_setup', { sheet_id: sheetId, columns: ['Fit (Output)'], preview: true })
  const order = preview.steps.map((s: any) => s.column)
  expect([...order].sort()).toEqual(['Clean name', 'Domain', 'Fit (Output)', 'Lookup'])
  expect(order.indexOf('Domain')).toBeLessThan(order.indexOf('Lookup'))
  expect(order.indexOf('Fit (Output)')).toBe(3)
  expect([...preview.inputs].sort()).toEqual(['Name', 'Website'])
  expect((await call(client, 'list_setups', {})).setups).toEqual([])

  const saved = await call(client, 'save_setup', { sheet_id: sheetId, name: 'Lead fit', columns: ['Fit (Output)'],
    description: 'Domain, lookup, then fit' })
  expect(saved.steps).toHaveLength(4)
  const full = await call(client, 'list_setups', { setup_id: saved.id })
  const http1 = full.spec.steps.find((s: any) => s.kind === 'http')
  expect(http1.request.url).toContain('{{Domain}}')
  expect(http1.runIf).toBe('{{Domain}} is not empty')
  expect(full.spec.steps.find((s: any) => s.kind === 'ai').model).toBe('deepseek/deepseek-v4-flash')
  expect(await callError(client, 'save_setup', { sheet_id: sheetId, name: 'LEAD FIT', columns: ['Domain'] }))
    .toContain('already exists')
  expect(await callError(client, 'save_setup', { sheet_id: sheetId, name: 'x', columns: ['Name'] }))
    .toContain("isn't a filled column")

  // A read-only token can look and preview, not save or delete.
  const reader = await mcpClient(await makeAccessToken(api, ['read'], 'setups-e2e-read'), 'reader')
  expect((await call(reader, 'list_setups', {})).setups).toHaveLength(1)
  await call(reader, 'save_setup', { sheet_id: sheetId, columns: ['Domain'], preview: true })
  expect(await callError(reader, 'save_setup', { sheet_id: sheetId, name: 'y', columns: ['Domain'] }))
    .toMatch(/scope/i)
  expect(await callError(reader, 'delete_setup', { setup_id: saved.id })).toMatch(/scope/i)

  // REST: the list, export (keys by name only), import under a free name, delete.
  const auth = { Authorization: `Bearer ${token}` }
  const list = await (await api.get(`${BASE}/api/v1/setups`, { headers: auth })).json()
  expect(list.setups.map((s: any) => s.name)).toEqual(['Lead fit'])
  const exported = await (await api.get(`${BASE}/api/v1/setups/${saved.id}/export`, { headers: auth })).json()
  expect(exported.filename).toBe('lead-fit.cubex-setup.json')
  expect(exported.file.format).toBe('cubex-setup')
  const imported = await api.post(`${BASE}/api/v1/setups/import`, { headers: auth, data: exported.file })
  expect(imported.status()).toBe(201)
  expect((await imported.json()).name).toBe('Lead fit (2)')
  const bad = await api.post(`${BASE}/api/v1/setups/import`, { headers: auth, data: { format: 'nope' } })
  expect(bad.status()).toBe(400)
  const steps = await (await api.get(`${BASE}/api/v1/sheets/${sheetId}/setup-steps`, { headers: auth })).json()
  expect(steps.steps.map((s: any) => s.column).sort()).toEqual(['Clean name', 'Domain', 'Fit (Output)', 'Lookup'])

  expect((await call(client, 'delete_setup', { setup_id: saved.id })).deleted).toBe(saved.id)
  expect((await call(client, 'list_setups', {})).setups.map((s: any) => s.name)).toEqual(['Lead fit (2)'])
  await clearSetups(api)
})
