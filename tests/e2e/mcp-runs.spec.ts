import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'

// Phase 2 MCP run tools (design-doc step 4): run_http_enrichment end-to-end
// (flat tool shape → HTTPAPIConfig), get_run_status polling, control_run
// cancel/rerun, run_ai_column's no-model error, and scope denials. Runs as
// test3 so its rate/table buckets don't collide with mcp.spec.ts (test2).

const JSON_URL = 'https://jsonplaceholder.typicode.com/todos/1'


async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'e2e-run-test', version: '1.0.0' })
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

async function pollStatus(client: Client, runType: string, runId: string, timeoutMs = 60_000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  let last: any = null
  while (Date.now() < deadline) {
    last = parseResult(await client.callTool({
      name: 'get_run_status', arguments: { run_type: runType, run_id: runId },
    }))
    if (['completed', 'failed', 'cancelled'].includes(last?.status)) return last
    await new Promise(r => setTimeout(r, 750))
  }
  throw new Error(`run never terminal: ${JSON.stringify(last)}`)
}

test('MCP runs: enrich via HTTP tool, poll status, rerun via control_run', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e mcp run'))

  const started = parseResult(await client.callTool({
    name: 'run_http_enrichment',
    arguments: {
      sheet_id: sheetId, url: JSON_URL,
      response_mapping: [{ json_path: '$.title', column_name: 'Title' }],
      master_column_name: 'Lookup',
    },
  }))
  expect(started.run_id).toBeTruthy()
  expect(started.master_column).toBe('Lookup')

  const done = await pollStatus(client, 'http', started.run_id)
  expect(done.status).toBe('completed')
  expect(done.processed_rows).toBe(2)

  // The enriched cells are visible through the data-plane tools.
  const rows = parseResult(await client.callTool({
    name: 'read_rows', arguments: { sheet_id: sheetId },
  }))
  expect(rows.rows[0].data.Title).toContain('delectus')

  // control_run rerun → NEW run id; then the old one is superseded (error).
  const rerun = parseResult(await client.callTool({
    name: 'control_run',
    arguments: { run_type: 'http', run_id: started.run_id, action: 'rerun', mode: 'all' },
  }))
  expect(rerun.run_id).toBeTruthy()
  expect(rerun.run_id).not.toBe(started.run_id)
  await pollStatus(client, 'http', rerun.run_id)
  const superseded = await client.callTool({
    name: 'control_run',
    arguments: { run_type: 'http', run_id: started.run_id, action: 'rerun' },
  })
  expect(superseded.isError).toBe(true)
  expect(parseResult(superseded as any).error).toContain('superseded')

  await client.close()
})

test('MCP runs: AI no-model error is actionable; scope denials name the scope', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 1)

  // No model anywhere (seed user has no defaults) → clear error, no run.
  const rw = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e mcp run'))
  const noModel = await rw.callTool({
    name: 'run_ai_column',
    arguments: { sheet_id: sheetId, column_name: 'ai', prompt: 'echo /val' },
  })
  expect(noModel.isError).toBe(true)
  expect(parseResult(noModel as any).error).toContain('No AI model selected')
  await rw.close()

  // Token without 'run': start + control denied, status read still allowed.
  const noRun = await mcpClient(await makeAccessToken(api, ['read', 'write'], 'e2e mcp norun'))
  const denied = await noRun.callTool({
    name: 'run_http_enrichment',
    arguments: {
      sheet_id: sheetId, url: JSON_URL,
      response_mapping: [{ json_path: '$.title', column_name: 'T' }],
    },
  })
  expect(denied.isError).toBe(true)
  expect(parseResult(denied as any).error).toContain("'run' scope")
  const controlDenied = await noRun.callTool({
    name: 'control_run', arguments: { run_type: 'ai', run_id: 'x', action: 'cancel' },
  })
  expect(controlDenied.isError).toBe(true)
  const statusOk = await noRun.callTool({
    name: 'get_run_status', arguments: { run_type: 'ai', run_id: 'nonexistent' },
  })
  expect(parseResult(statusOk as any).error).toContain('Run not found') // read allowed, run just missing
  await noRun.close()
})
