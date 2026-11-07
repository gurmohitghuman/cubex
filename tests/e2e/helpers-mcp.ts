import { expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from '@modelcontextprotocol/client'
import { BASE } from './helpers'

// An MCP client for a token, and tool calls read back as JSON: `call` expects
// success, `callError` expects the tool's error and returns its message.
// mcpClient connects with initialize (2025-11-25); modernMcpClient is the v2
// client pinned to 2026-07-28 (server/discover, _meta on every request).
export async function mcpClient(token: string, name = 'e2e'): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }))
  return client
}

export async function modernMcpClient(token: string, name = 'e2e-modern'): Promise<ModernClient> {
  const client = new ModernClient({ name, version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } })
  await client.connect(new ModernTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }))
  return client
}

type Res = { content?: Array<{ type: string; text?: string }>; isError?: boolean }
const textOf = (res: Res) => JSON.parse(res.content?.find(c => c.type === 'text')?.text ?? 'null')

export async function call(client: Client | ModernClient, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args }) as Res
  const json = textOf(res)
  expect(res.isError, `${name}: ${JSON.stringify(json)}`).toBeFalsy()
  return json
}

export async function callError(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await client.callTool({ name, arguments: args }) as Res
  expect(res.isError, `${name} should fail`).toBeTruthy()
  return String(textOf(res)?.error ?? '')
}

// Polls get_run_status until the run reaches one of `statuses`.
export async function waitMcpRun(client: Client, runId: string, statuses: string[], timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const s = await call(client, 'get_run_status', { run_type: 'enrichment', run_id: runId, wait_seconds: 2 })
    if (statuses.includes(s.status)) return s
    if (Date.now() > until) throw new Error(`run ${runId} is ${s.status}, wanted ${statuses.join('/')}`)
  }
}
