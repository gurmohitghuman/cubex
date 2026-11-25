import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'

// A sheet's prompt starters over REST (GET /api/v1/sheets/:id/prompt-starters) and MCP (list_prompt_starters),
// services/prompt-starters-read.ts: the five the app's AI column dialog offers, written with the sheet's own
// columns as /references, each as run_ai_column's arguments; a read-only key is enough; an unknown sheet is not
// found (as one in the trash, by the same ownership check).

let api: APIRequestContext
let reader: APIRequestContext
let readMcp: Client

test.beforeAll(async () => {
  api = await authedApi()
  const token = await makeAccessToken(api, ['read'], 'e2e prompt starters read')
  reader = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` } })
  readMcp = await mcpClient(token)
})
test.afterAll(async () => { await Promise.all([readMcp?.close(), reader?.dispose()]) })

test('REST and MCP: the five starters from the sheet\'s columns, as run_ai_column\'s arguments', async () => {
  const { sheetId } = await seedSheet(api, 2)
  for (const columnName of ['Company website', 'Industry']) {
    expect((await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName } })).ok()).toBeTruthy()
  }
  const res = await reader.get(`/api/v1/sheets/${sheetId}/prompt-starters`)
  expect(res.status()).toBe(200)
  const rest = await res.json()
  expect(rest.starters.map((s: { id: string }) => s.id)).toEqual(['qualify', 'classify', 'opener', 'score', 'profile'])
  const qualify = rest.starters[0]
  expect(qualify).toMatchObject({ label: 'Qualify (YES/NO)', run: { column_name: 'Qualified' } })
  expect(qualify.run.prompt).toContain('Company website: /company_website')
  expect(qualify.run.prompt).toContain('Industry: /industry')
  expect(qualify.run.output_columns).toBeUndefined()
  const profile = rest.starters[4]
  expect(profile.run.output_columns.map((c: { column_name: string }) => c.column_name))
    .toEqual(['Industry 2', 'Employees', 'Headquarters', 'Founded', 'B2B', 'Summary'])
  expect(rest.note).toMatch(/square brackets/)

  const mcp = await call(readMcp, 'list_prompt_starters', { sheet_id: sheetId })
  expect(mcp).toEqual(rest)

  expect((await reader.get('/api/v1/sheets/no-such-sheet/prompt-starters')).status()).toBe(404)
  // MCP adds where to find the right id (mcp/next-steps.ts).
  expect(await callError(readMcp, 'list_prompt_starters', { sheet_id: 'no-such-sheet' })).toMatch(/^Sheet not found\. /)
})
