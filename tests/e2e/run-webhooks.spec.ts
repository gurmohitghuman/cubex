import { test, expect, APIRequestContext } from '@playwright/test'
import { createHmac } from 'node:crypto'
import { authedApi, seedSheet, importCsv } from './helpers'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'
import { call, mcpClient } from './helpers-mcp'
import { Receiver, type Hit } from './helpers-receiver'

// "Run finished" webhooks over /api/v1 and MCP, delivered to a local receiver
// through the real outbound path (the SSRF guard included,
// tests/e2e/net-shim.cjs): a finished run POSTs a signed notice; a webhook for
// named runs only hears runs started with its id; a failing URL gets 3 tries
// and the log says so; a test notice; a new secret; cancelled and AI runs too;
// private URLs and bad ids are refused; read tokens can't change anything.
const rx = new Receiver()
let api: APIRequestContext
let v1: APIRequestContext
let readOnly: APIRequestContext
let writeOnly: APIRequestContext

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await rx.start()
  api = await authedApi()
  for (const h of (await (await api.get('/api/settings/run-webhooks')).json()).webhooks) {
    await api.delete(`/api/settings/run-webhooks/${h.id}`)
  }
  v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'run webhooks spec'))
  readOnly = await bearer(await makeToken(api, ['read'], 'run webhooks read spec'))
  writeOnly = await bearer(await makeToken(api, ['read', 'write'], 'run webhooks write spec'))
  rx.on('/data', { status: 200, body: '{"ok":"yes"}' })
})
test.afterAll(async () => {
  await rx.stop(); await v1?.dispose(); await readOnly?.dispose(); await writeOnly?.dispose()
})

const signed = (secret: string, hit: Hit) =>
  hit.headers['x-cubex-signature'] === `sha256=${createHmac('sha256', secret).update(hit.body).digest('hex')}`
async function addHook(url: string, everyRun = true): Promise<{ id: string; secret: string }> {
  const res = await v1.post('/api/v1/run-webhooks', { data: { url, every_run: everyRun } })
  expect(res.status(), await res.text()).toBe(201)
  const out = await res.json()
  return { id: out.webhook.id, secret: out.secret }
}
async function httpRun(
  extra: Record<string, unknown> = {}, path = '/data',
): Promise<{ run_id: string; sheetId: string }> {
  const { sheetId } = await seedSheet(api, 1)
  expect((await importCsv(api, sheetId, 'Name\nAda\n', { replaceData: true })).ok()).toBeTruthy()
  const res = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { url: rx.url(path), response_mapping: [{ json_path: '$.ok', column_name: 'OK' }], ...extra },
  })
  expect(res.status(), await res.text()).toBe(202)
  return { ...(await res.json()), sheetId }
}
const deliveries = async (id: string) =>
  (await (await v1.get(`/api/v1/run-webhooks/${id}/deliveries`)).json()).deliveries

let every: { id: string; secret: string }

test('saving: private URLs, credentials, duplicates and tokens without run are refused', async () => {
  const privateUrls = [
    `http://127.0.0.1:${rx.port}/hook`, `http://localhost:${rx.port}/hook`, 'http://169.254.169.254/x',
  ]
  for (const url of privateUrls) {
    const res = await v1.post('/api/v1/run-webhooks', { data: { url } })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/only to public addresses/)
  }
  const creds = await v1.post('/api/v1/run-webhooks', { data: { url: rx.url('/hook').replace('//', '//u:p@') } })
  expect((await creds.json()).error).toMatch(/user name or password/)
  every = await addHook(rx.url('/hook', 'every'))
  expect(every.secret).toMatch(/^cubex_whsig_[A-Za-z0-9_-]{43}$/)
  expect((await v1.post('/api/v1/run-webhooks', { data: { url: rx.url('/hook', 'every') } })).status()).toBe(409)
  const list = await (await readOnly.get('/api/v1/run-webhooks')).json()
  expect(list.webhooks.map((h: { id: string }) => h.id)).toEqual([every.id])
  expect(JSON.stringify(list)).not.toContain('cubex_whsig_')
  expect((await readOnly.post('/api/v1/run-webhooks', { data: { url: rx.url('/x') } })).status()).toBe(403)
  expect((await readOnly.delete(`/api/v1/run-webhooks/${every.id}`)).status()).toBe(403)
  // Where Cubex sends requests is a 'run' decision, as for HTTP API columns.
  expect((await writeOnly.post('/api/v1/run-webhooks', { data: { url: rx.url('/w') } })).status()).toBe(403)
  expect((await writeOnly.post(`/api/v1/run-webhooks/${every.id}/test`)).status()).toBe(403)
})

test('a finished run POSTs a signed notice', async () => {
  rx.on('/hook', { status: 200 })
  const r = await httpRun()
  await waitForTerminal(v1, `/api/v1/http-runs/${r.run_id}`)
  const [hit] = (await rx.waitFor('/hook', 1)).filter(h => JSON.parse(h.body).run_id === r.run_id)
  expect(hit.method).toBe('POST')
  expect(hit.headers['content-type']).toBe('application/json')
  expect(hit.headers['x-cubex-event']).toBe('run.finished')
  expect(signed(every.secret, hit)).toBe(true)
  const body = JSON.parse(hit.body)
  expect(Object.keys(body)).toEqual(['event', 'run_id', 'kind', 'sheet_id', 'status', 'finished_at'])
  expect(body).toMatchObject({ event: 'run.finished', run_id: r.run_id, kind: 'http', sheet_id: r.sheetId,
    status: 'completed' })
  const [d] = await deliveries(every.id)
  expect(d).toMatchObject({ id: hit.headers['x-cubex-delivery'], state: 'delivered', response_code: 200, tries: 1 })
})

test('a webhook for named runs only hears runs started with its id; a bad id is refused', async () => {
  rx.on('/named', { status: 204 })
  const named = await addHook(rx.url('/named', 'named'), false)
  await waitForTerminal(v1, `/api/v1/http-runs/${(await httpRun()).run_id}`)
  const mine = await httpRun({ webhook_id: named.id })
  expect(mine).toMatchObject({ webhook_id: named.id })
  await waitForTerminal(v1, `/api/v1/http-runs/${mine.run_id}`)
  const hits = await rx.waitFor('/named', 1)
  await new Promise(res => setTimeout(res, 1000))
  expect(rx.hitsOn('/named').map(h => JSON.parse(h.body).run_id)).toEqual([mine.run_id])
  expect(signed(named.secret, hits[0])).toBe(true)
  const { sheetId } = await seedSheet(api, 1)
  const bad = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { url: rx.url('/data'), response_mapping: [{ json_path: '$.ok', column_name: 'OK' }], webhook_id: 'nope' },
  })
  expect(bad.status()).toBe(400)
  expect((await bad.json()).error).toMatch(/doesn't match a run webhook/)
  expect((await v1.delete(`/api/v1/run-webhooks/${named.id}`)).ok()).toBeTruthy()
})

test('a URL that keeps failing gets 3 tries, spaced out, and the log says why', async () => {
  rx.on('/down', { status: 500 })
  const down = await addHook(rx.url('/down', 'down'), false)
  const r = await httpRun({ webhook_id: down.id })
  await waitForTerminal(v1, `/api/v1/http-runs/${r.run_id}`)
  const hits = await rx.waitFor('/down', 3, 30_000)
  expect(hits[1].at - hits[0].at).toBeGreaterThanOrEqual(200)
  expect(hits[2].at - hits[1].at).toBeGreaterThanOrEqual(1200)
  expect(new Set(hits.map(h => h.headers['x-cubex-delivery'])).size).toBe(1)
  expect(new Set(hits.map(h => h.body)).size).toBe(1)
  await expect.poll(async () => (await deliveries(down.id))[0]?.state, { timeout: 10_000 }).toBe('failed')
  expect((await deliveries(down.id))[0]).toMatchObject({ tries: 3, response_code: 500, error: 'The URL answered 500.' })
  await new Promise(res => setTimeout(res, 2500))
  expect(rx.hitsOn('/down')).toHaveLength(3)
  await v1.delete(`/api/v1/run-webhooks/${down.id}`)
})

test('a test notice, and a new secret replaces the old one', async () => {
  const test1 = await (await v1.post(`/api/v1/run-webhooks/${every.id}/test`)).json()
  expect(test1).toMatchObject({ event: 'test', state: 'delivered', response_code: 200, tries: 1 })
  const hit = rx.hitsOn('/hook').find(h => h.headers['x-cubex-delivery'] === test1.id)!
  expect(JSON.parse(hit.body)).toMatchObject({ event: 'test', run_id: null, kind: null, status: null })
  expect(signed(every.secret, hit)).toBe(true)
  const fresh = (await (await v1.post(`/api/v1/run-webhooks/${every.id}/secret`)).json()).secret
  expect(fresh).not.toBe(every.secret)
  const test2 = await (await v1.post(`/api/v1/run-webhooks/${every.id}/test`)).json()
  const hit2 = rx.hitsOn('/hook').find(h => h.headers['x-cubex-delivery'] === test2.id)!
  expect(signed(fresh, hit2)).toBe(true)
  expect(signed(every.secret, hit2)).toBe(false)
  every = { ...every, secret: fresh }
})

test('a cancelled run is told as cancelled', async () => {
  rx.on('/stall', { status: 503, headers: { 'Retry-After': '30' } })
  const r = await httpRun({}, '/stall')
  await rx.waitFor('/stall', 1)
  expect((await v1.post(`/api/v1/http-runs/${r.run_id}/cancel`)).ok()).toBeTruthy()
  await expect.poll(() => rx.hitsOn('/hook').some(h => {
    const b = JSON.parse(h.body)
    return b.run_id === r.run_id && b.status === 'cancelled'
  }), { timeout: 10_000 }).toBe(true)
})

test('an AI run started over MCP with webhook_id, and the log over MCP', async () => {
  test.setTimeout(90_000)
  await api.put('/api/settings/openrouter-key', { data: { apiKey: 'sk-or-v1-invalid-e2e' } })
  try {
    rx.on('/ai', { status: 200 })
    const aiHook = await addHook(rx.url('/ai', 'ai'), false)
    const { sheetId } = await seedSheet(api, 1)
    const mcp = await mcpClient(await makeToken(api, ['read', 'run'], 'run webhooks mcp spec'))
    const started = await call(mcp, 'run_ai_column', {
      sheet_id: sheetId, column_name: 'Hi', prompt: 'Say hi to /val', model: 'deepseek/deepseek-v4-flash',
      webhook_id: aiHook.id,
    })
    expect(started.webhook_id).toBe(aiHook.id)
    const [hit] = await rx.waitFor('/ai', 1, 60_000)
    expect(JSON.parse(hit.body)).toMatchObject({ run_id: started.run_id, kind: 'ai', sheet_id: sheetId })
    const listed = await call(mcp, 'list_run_webhooks', { webhook_id: aiHook.id })
    expect(listed.deliveries[0]).toMatchObject({ run_id: started.run_id, kind: 'ai', state: 'delivered' })
    await mcp.close()
    await v1.delete(`/api/v1/run-webhooks/${aiHook.id}`)
  } finally {
    await api.delete('/api/settings/openrouter-key')
  }
})
