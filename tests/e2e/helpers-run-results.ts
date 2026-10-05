import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { BASE } from './helpers'

// Shared plumbing for the get_run_results specs (mcp-run-results*.spec.ts),
// split out for the 200-line guardrail.

// A URL that 404s for every row → every row fails, giving us real per-row
// errors to classify. Same live host the other HTTP specs use (the SSRF guard
// blocks localhost mocks).
export const BAD_URL = 'https://jsonplaceholder.typicode.com/todos/999999999'
export const GOOD_URL = 'https://jsonplaceholder.typicode.com/todos/1'

export async function mcpClient(token: string, name = 'e2e-run-results'): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

export function parseResult(res: { content?: Array<{ type: string; text?: string }> }): any {
  const text = res.content?.find(c => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

export async function pollTerminal(
  client: Client, runId: string, timeoutMs = 60_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs
  let last: any = null
  while (Date.now() < deadline) {
    last = parseResult(await client.callTool({
      name: 'get_run_status', arguments: { run_type: 'http', run_id: runId },
    }))
    if (['completed', 'failed', 'cancelled'].includes(last?.status)) return last
    await new Promise(r => setTimeout(r, 750))
  }
  throw new Error(`run never terminal: ${JSON.stringify(last)}`)
}

// Start an HTTP enrichment run against `url` and wait for it to finish.
export async function runEnrichment(
  client: Client, sheetId: string, url: string,
): Promise<{ run_id: string }> {
  const started = parseResult(await client.callTool({
    name: 'run_http_enrichment',
    arguments: {
      sheet_id: sheetId,
      url,
      method: 'GET',
      response_mapping: [{ json_path: '$.title', column_name: 'Title' }],
      master_column_name: 'Lookup',
    },
  }))
  await pollTerminal(client, started.run_id)
  return started
}
