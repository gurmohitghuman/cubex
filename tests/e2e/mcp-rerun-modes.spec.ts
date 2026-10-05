import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'

// Rerun target modes. The incident: an AI
// rerun meant to retry 10 failed rows re-ran all 9,675 because the implicit
// default ("empty or errored") matches every blank cell on a fresh column.
// Contract now: an AI rerun over MCP MUST state its target — mode or row_ids.
// Runs as test4 so its rate/table buckets don't collide with other specs.


async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'e2e-rerun-modes', version: '1.0.0' })
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

function isError(res: any): boolean {
  return res?.isError === true
}

function errorText(res: any): string {
  return res?.content?.find((c: any) => c.type === 'text')?.text ?? ''
}

test('MCP AI rerun requires an explicit target', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'rerun-modes')
  const client = await mcpClient(token)

  // A rerun needs a real run id to address. We don't need the run to have
  // SUCCEEDED — the mode guard runs before the run is even looked up, which is
  // the point: the check is cheap and happens before anything bills.
  const bogusRunId = '00000000-0000-4000-8000-000000000000'

  // No mode, no row_ids → refused with actionable guidance, BEFORE any lookup.
  const noTarget = await client.callTool({
    name: 'control_run',
    arguments: { run_type: 'ai', run_id: bogusRunId, action: 'rerun' },
  })
  expect(isError(noTarget)).toBe(true)
  const msg = errorText(noTarget)
  // The message must name every option — an agent reads this to recover.
  expect(msg).toContain('errored')
  expect(msg).toContain('empty')
  expect(msg).toContain('missing')
  expect(msg).toContain('all')
  // And it must be the MODE guard talking, not a "run not found" — proving the
  // guard fires before the run lookup (so a real run can't slip past it).
  expect(msg.toLowerCase()).not.toContain('not found')

  // With a mode supplied, the guard passes and we reach the real lookup, which
  // legitimately 404s on the bogus id. Different error = guard cleared.
  const withMode = await client.callTool({
    name: 'control_run',
    arguments: { run_type: 'ai', run_id: bogusRunId, action: 'rerun', mode: 'errored' },
  })
  expect(isError(withMode)).toBe(true)
  expect(errorText(withMode).toLowerCase()).toContain('not found')

  // row_ids alone also satisfies the guard (explicit subset, no mode needed).
  const withRowIds = await client.callTool({
    name: 'control_run',
    arguments: {
      run_type: 'ai', run_id: bogusRunId, action: 'rerun',
      row_ids: ['00000000-0000-4000-8000-000000000001'],
    },
  })
  expect(isError(withRowIds)).toBe(true)
  expect(errorText(withRowIds).toLowerCase()).toContain('not found')

  await client.close()
})

test('MCP HTTP rerun rejects AI-only modes', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await seedSheet(api, 2)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'rerun-modes-http')
  const client = await mcpClient(token)

  const bogusRunId = '00000000-0000-4000-8000-000000000000'

  // 'errored' and 'empty' are AI-only. HTTP runs key on a status column with
  // different semantics; silently accepting them would target the wrong rows.
  for (const mode of ['errored', 'empty']) {
    const res = await client.callTool({
      name: 'control_run',
      arguments: { run_type: 'http', run_id: bogusRunId, action: 'rerun', mode },
    })
    expect(isError(res)).toBe(true)
    expect(errorText(res)).toContain("'missing' or 'all'")
  }

  // HTTP's own modes still pass the guard and reach the lookup.
  for (const mode of ['missing', 'all']) {
    const res = await client.callTool({
      name: 'control_run',
      arguments: { run_type: 'http', run_id: bogusRunId, action: 'rerun', mode },
    })
    expect(isError(res)).toBe(true)
    expect(errorText(res).toLowerCase()).toContain('not found')
  }

  // HTTP keeps its historical default (no mode = every row) — unchanged, since
  // the money-risk asymmetry is AI-specific (HTTP hits the user's own API).
  const noMode = await client.callTool({
    name: 'control_run',
    arguments: { run_type: 'http', run_id: bogusRunId, action: 'rerun' },
  })
  expect(isError(noMode)).toBe(true)
  expect(errorText(noMode).toLowerCase()).toContain('not found')

  await client.close()
})

test('v1 AI rerun validates mode and keeps its back-compat default', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'rerun-modes-v1')
  const bogusRunId = '00000000-0000-4000-8000-000000000000'

  // Unknown mode → 400 naming the valid set (validation before the run lookup).
  const bad = await api.post(`${BASE}/api/v1/ai-runs/${bogusRunId}/rerun`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { mode: 'everything' },
  })
  expect(bad.status()).toBe(400)
  expect((await bad.json()).error).toContain('errored')

  // Omitted mode (and no row_ids) → 400 on v1 too, as on MCP: a default of
  // 'missing' re-billed every empty row. Checked before the run lookup.
  const omitted = await api.post(`${BASE}/api/v1/ai-runs/${bogusRunId}/rerun`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {},
  })
  expect(omitted.status()).toBe(400)
  expect((await omitted.json()).error).toContain('mode')
})
