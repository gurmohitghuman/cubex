import path from 'node:path'
import { createRequire } from 'node:module'
import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet, assertTestDb } from './helpers'
import { JSON_URL, makeToken, bearer, waitForTerminal } from './api-v1-run-helpers'
import { mcpClient, call, callError } from './helpers-mcp'

// Agents' "Paste a cURL command": POST /api/v1/sheets/:id/http-runs and MCP
// run_http_enrichment take `curl`. A key in the command is refused until
// save_keys, which needs 'secrets', saves it as a saved key (an estimate saves
// nothing), and the run's stored setup holds {{name}}, never the key. A
// $VARIABLE uses the saved key of that name. Also: REST now passes run_if on.

const SECRET = 'sk-proj-e2eAGENT0123456789abcdefgh'
const CURL = `curl '${JSON_URL}' -H 'Authorization: Bearer ${SECRET}'`
const response_mapping = [{ json_path: '$.title', column_name: 'Title' }]

// Specs run as ESM, where `require` is undefined (as in helpers.ts).
const require = createRequire(import.meta.url)

// The run's stored setup, read from the throwaway test DB (no route returns it).
function storedConfig(runId: string): string {
  const Database = require(path.join(process.cwd(), 'node_modules/better-sqlite3'))
  const db = new Database(assertTestDb(process.env.DB_PATH), { readonly: true })
  try {
    return (db.prepare('SELECT config FROM http_runs WHERE id = ?').get(runId) as { config: string }).config
  } finally {
    db.close()
  }
}

async function keyNames(api: APIRequestContext): Promise<string[]> {
  return (await (await api.get('/api/settings/api-keys')).json()).map((k: { name: string }) => k.name)
}

async function clearKeys(api: APIRequestContext, prefix: string) {
  const keys = await (await api.get('/api/settings/api-keys')).json()
  for (const k of keys) if (k.name.startsWith(prefix)) await api.delete(`/api/settings/api-keys/${k.id}`)
}

test('REST: a key in curl needs save_keys and the secrets scope; the run never stores the key', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await clearKeys(api, 'typicode')
  const { sheetId } = await seedSheet(api, 2)
  const runOnly = await bearer(await makeToken(api, ['read', 'run'], 'e2e curl run'))
  const secrets = await bearer(await makeToken(api, ['read', 'run', 'secrets'], 'e2e curl secrets'))
  // Each started run gets its own output column (a second "Title" would be refused).
  let n = 0
  const start = (v1: APIRequestContext, data: Record<string, unknown>) =>
    v1.post(`/api/v1/sheets/${sheetId}/http-runs`, {
      data: { response_mapping: [{ json_path: '$.title', column_name: `Title ${++n}` }], ...data },
    })

  const plain = await start(secrets, { curl: CURL })
  expect(plain.status()).toBe(400)
  const why = (await plain.json()).error as string
  expect(why).toContain('Authorization header')
  expect(why).toContain('save_keys: true')
  expect(why).not.toContain('e2eAGENT')

  expect((await start(runOnly, { curl: CURL, save_keys: true })).status()).toBe(403)
  const mixed = await start(secrets, { curl: CURL, url: JSON_URL, save_keys: true })
  expect(mixed.status()).toBe(400)
  expect((await mixed.json()).error).toContain('Pass either curl or url')
  const stray = await start(secrets, { url: JSON_URL, save_keys: true })
  expect((await stray.json()).error).toContain('save_keys goes with curl')

  // An estimate lists the key it would save and saves nothing.
  const est = await start(secrets, { curl: CURL, save_keys: true, estimate_only: true })
  expect(est.status()).toBe(200)
  expect((await est.json()).keys_to_save).toEqual(['typicode'])
  expect(await keyNames(api)).not.toContain('typicode')

  // A start the run itself refuses (a JSONPath it can't use) saves no key.
  const refused = await secrets.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { curl: CURL, save_keys: true, response_mapping: [{ json_path: '$..[?(@.x)]', column_name: 'Bad path' }] },
  })
  expect(refused.status()).toBe(400)
  expect(await keyNames(api)).not.toContain('typicode')

  const go = await start(secrets, { curl: CURL, save_keys: true, master_column_name: 'Curl run' })
  expect(go.status()).toBe(202)
  const started = await go.json()
  expect(started.saved_keys).toEqual(['typicode'])
  await waitForTerminal(secrets, `/api/v1/http-runs/${started.run_id}`)
  expect(await keyNames(api)).toContain('typicode')
  const config = storedConfig(started.run_id)
  expect(config).toContain('Bearer {{typicode}}')
  expect(config).not.toContain('e2eAGENT')
  const job = await (await api.get(`/api/http/jobs/${started.run_id}`)).json()
  expect(job.results[0].request_config).toContain('[REDACTED:typicode]')

  // Again: the key already saved with that value is used, not copied.
  const again = await start(secrets, { curl: CURL, save_keys: true, master_column_name: 'Curl again' })
  expect(again.status(), await again.text()).toBe(202)
  expect((await again.json()).saved_keys).toEqual([])
  expect((await keyNames(api)).filter(n => n.startsWith('typicode'))).toEqual(['typicode'])
  await waitForTerminal(secrets, `/api/v1/http-runs/${(await again.json()).run_id}`)

  // run_if reaches the REST start (it used to be dropped).
  const ruled = await start(runOnly, {
    url: JSON_URL, master_column_name: 'Ruled', run_if: '{{val}} is "v0"',
  })
  expect(ruled.status(), await ruled.text()).toBe(202)
  const ruledBody = await ruled.json()
  expect(ruledBody.run_if).toBe('{{val}} is "v0"')
  const done = await waitForTerminal(runOnly, `/api/v1/http-runs/${ruledBody.run_id}`)
  expect(done.condition_skipped_rows).toBe(1)

  await runOnly.dispose(); await secrets.dispose(); await api.dispose()
})

test('MCP: run_http_enrichment takes curl; a $VARIABLE uses the saved key with that name', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await clearKeys(api, 'E2E_CURL')
  const made = await api.post('/api/settings/api-keys', {
    data: { name: 'E2E_CURL_KEY', key_type: 'api_key', key_value: 'e2e-curl-key-0123456789' },
  })
  expect(made.ok()).toBeTruthy()
  const { sheetId } = await seedSheet(api, 1)
  const client = await mcpClient(await makeToken(api, ['read', 'run', 'secrets'], 'e2e curl mcp'))
  const runOnly = await mcpClient(await makeToken(api, ['read', 'run'], 'e2e curl mcp run'))

  const tool = (await client.listTools()).tools.find(t => t.name === 'run_http_enrichment')!
  expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual(
    expect.arrayContaining(['curl', 'save_keys', 'url']),
  )

  const cmd = `curl ${JSON_URL} -H "X-Key: $E2E_CURL_KEY"`
  expect(await callError(runOnly, 'run_http_enrichment', { sheet_id: sheetId, curl: cmd, response_mapping }))
    .toContain("'secrets' scope")
  const r = await call(client, 'run_http_enrichment', {
    sheet_id: sheetId, curl: cmd, response_mapping, master_column_name: 'From curl',
  })
  expect(r.saved_keys).toEqual([])
  let status = ''
  for (const until = Date.now() + 45_000; Date.now() < until && !['completed', 'failed'].includes(status);) {
    status = (await call(client, 'get_run_status', { run_type: 'http', run_id: r.run_id, wait_seconds: 5 })).status
  }
  expect(status).toBe('completed')
  expect(storedConfig(r.run_id)).toContain('"X-Key":"{{E2E_CURL_KEY}}"')

  const literal = await callError(client, 'run_http_enrichment', {
    sheet_id: sheetId, curl: `curl ${JSON_URL} -H 'X-API-Key: literal-key-0123456789'`, response_mapping,
  })
  expect(literal).toContain('save_keys')
  expect(literal).not.toContain('literal-key-0123456789')

  await client.close(); await runOnly.close(); await api.dispose()
})
