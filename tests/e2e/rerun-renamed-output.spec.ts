import { test, expect, type APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet, importCsv, getSheet } from './helpers'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'
import { mcpClient, call, callError } from './helpers-mcp'

// A rerun by run id (MCP control_run, REST POST /api/v1/ai-runs/:id/rerun)
// after the run's "X (Output)" column was renamed "X": the run that owns the
// column is rerun into it, no "X (Output)" comes back. And once that column is
// deleted, a rerun by id is refused instead of bringing it back. The AI runs
// fail fast for free on a fake OpenRouter key.
let api: APIRequestContext
let v1: APIRequestContext
let token: string

test.beforeAll(async () => {
  api = await authedApi()
  token = await makeToken(api, ['read', 'write', 'run'], 'rerun renamed output spec')
  v1 = await bearer(token)
})
test.afterAll(async () => { await v1?.dispose() })

const columns = async (sheetId: string): Promise<string[]> => (await getSheet(api, sheetId)).data.columns

test('rerun by id after renaming "Blurb (Output)" to "Blurb", over MCP and REST', async () => {
  test.setTimeout(120_000)
  const { sheetId } = await seedSheet(api, 1)
  expect((await importCsv(api, sheetId, 'Name\nAda\nBo\n', { replaceData: true })).ok()).toBeTruthy()
  expect((await api.put('/api/settings/openrouter-key', { data: { apiKey: 'sk-or-v1-invalid-e2e' } })).ok())
    .toBeTruthy()
  try {
    const client = await mcpClient(token)
    const first = await call(client, 'run_ai_column', { sheet_id: sheetId, column_name: 'Blurb',
      prompt: 'Describe /name', model: 'deepseek/deepseek-v4-flash' })
    await waitForTerminal(v1, `/api/v1/ai-runs/${first.run_id}`)
    await call(client, 'rename_column', { sheet_id: sheetId, column: 'Blurb (Output)', new_name: 'Blurb' })

    // MCP: the renamed column's run reruns into it.
    const mcp = await call(client, 'control_run', { run_type: 'ai', run_id: first.run_id, action: 'rerun',
      mode: 'errored' })
    expect(mcp.target_rows).toBe(2)
    const mcpRun = await waitForTerminal(v1, `/api/v1/ai-runs/${mcp.run_id}`)
    expect(mcpRun.column_name).toBe('Blurb')

    // REST: the same through the new run's id.
    const rest = await v1.post(`/api/v1/ai-runs/${mcp.run_id}/rerun`, { data: { mode: 'errored' } })
    expect(rest.status(), await rest.text()).toBe(202)
    const restRun = await rest.json()
    expect(restRun.target_rows).toBe(2)
    await waitForTerminal(v1, `/api/v1/ai-runs/${restRun.run_id}`)
    const cols = await columns(sheetId)
    expect(cols).toContain('Blurb')
    expect(cols).not.toContain('Blurb (Output)')

    // The column deleted: its run is refused, and nothing is brought back.
    await call(client, 'delete_column', { sheet_id: sheetId, column: 'Blurb' })
    expect(await callError(client, 'control_run', { run_type: 'ai', run_id: restRun.run_id, action: 'rerun',
      mode: 'all' })).toMatch(/was deleted/)
    const gone = await v1.post(`/api/v1/ai-runs/${restRun.run_id}/rerun`, { data: { mode: 'all' } })
    expect(gone.status()).toBe(404)
    expect((await columns(sheetId)).filter(c => c.includes('Blurb'))).toEqual([])
  } finally {
    await api.delete('/api/settings/openrouter-key')
  }
})
