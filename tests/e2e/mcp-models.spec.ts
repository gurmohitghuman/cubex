import { test, expect, APIRequestContext } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'

// AI-model tools: list_models discovery (search + page cap so 300+ models
// never flood agent context) and set_default_model (account + per-sheet, with
// typo rejection against the live catalog). Runs as test2 — mcp-runs (test3)
// asserts the NO-default error, so this spec must not leak a default onto
// that user; it also clears its own defaults before finishing.

const MODEL = 'openai/gpt-4o-mini'

// Delegates to helpers.makeAccessToken, which mints straight into the test DB.
async function makeToken(api: APIRequestContext, scopes: string[], name: string): Promise<string> {
  return makeAccessToken(api, scopes, name)
}

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'e2e-models-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

function parseResult(res: { content?: Array<{ type: string; text?: string }> }): any {
  const text = res.content?.find(c => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

test('MCP models: discover, set defaults (account + sheet), resolve in runs, clear', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 1)
  const client = await mcpClient(await makeToken(api, ['read', 'write', 'run'], 'e2e mcp models'))
  const call = async (name: string, args: any) => parseResult(await client.callTool({ name, arguments: args }))

  // Discovery: capped page + total, search narrows to the exact id.
  const all = await call('list_models', {})
  expect(all.models.length).toBeLessThanOrEqual(20)
  expect(all.total_matching).toBeGreaterThan(20)
  expect(all.models[0]).toHaveProperty('pricing')
  const searched = await call('list_models', { search: MODEL })
  expect(searched.models.map((m: any) => m.id)).toContain(MODEL)

  // Typo'd default is rejected with a pointer at list_models.
  const typo = await client.callTool({ name: 'set_default_model', arguments: { model: 'not/areal-model-xyz' } })
  expect(typo.isError).toBe(true)
  expect(parseResult(typo as any).error).toContain('list_models')

  // Account default set → visible in list_models → a model-less run resolves it.
  expect((await call('set_default_model', { model: MODEL })).account_default_model).toBe(MODEL)
  expect((await call('list_models', { search: MODEL })).account_default_model).toBe(MODEL)
  const run = await call('run_ai_column', { sheet_id: sheetId, column_name: 'ai', prompt: 'echo /val' })
  expect(run.run_id).toBeTruthy() // started — the default resolved (it then fails: no OpenRouter key)

  // Sheet default shows up on get_sheet.
  expect((await call('set_default_model', { model: MODEL, sheet_id: sheetId })).default_ai_model).toBe(MODEL)
  expect((await call('get_sheet', { sheet_id: sheetId })).default_ai_model).toBe(MODEL)

  // Clear both → model-less runs error again with the actionable message.
  await call('set_default_model', { model: null, sheet_id: sheetId })
  expect((await call('set_default_model', { model: null })).account_default_model).toBeNull()
  const noModel = await client.callTool({
    name: 'run_ai_column', arguments: { sheet_id: sheetId, column_name: 'ai2', prompt: 'echo /val' },
  })
  expect(noModel.isError).toBe(true)
  expect(parseResult(noModel as any).error).toContain('No AI model selected')

  // Read-only scope cannot set defaults (but can list).
  const ro = await mcpClient(await makeToken(api, ['read'], 'e2e mcp models ro'))
  expect((await parseResult(await ro.callTool({ name: 'list_models', arguments: { limit: 1 } }))).models).toHaveLength(1)
  const denied = await ro.callTool({ name: 'set_default_model', arguments: { model: MODEL } })
  expect(denied.isError).toBe(true)
  expect(parseResult(denied as any).error).toContain("'write' scope")
  await ro.close()

  await client.close()
})
