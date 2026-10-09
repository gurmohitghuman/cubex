import { expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { BASE } from './helpers'

// An MCP client for a token, and tool calls read back as JSON: `call` expects
// success, `callError` expects the tool's error and returns its message.
export async function mcpClient(token: string, name = 'e2e'): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }))
  return client
}

type Res = { content?: Array<{ type: string; text?: string }>; isError?: boolean }
const textOf = (res: Res) => JSON.parse(res.content?.find(c => c.type === 'text')?.text ?? 'null')

export async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
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
