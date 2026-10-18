import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet, importCsv } from './helpers'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'
import { Receiver } from './helpers-receiver'

// HTTP API columns against a local receiver, through the real outbound path
// (the SSRF guard included, tests/e2e/net-shim.cjs): automatic retries (which
// failures, which methods, Retry-After, the column's count, pause and cancel
// during a wait), the response code column, "skip empty values", and values
// escaped for where they go. The guard still refuses loopback.
const rx = new Receiver()
let api: APIRequestContext
let v1: APIRequestContext

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await rx.start()
  api = await authedApi()
  v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'http retry spec'))
})
test.afterAll(async () => { await rx.stop(); await v1?.dispose() })

async function sheetWith(csv: string): Promise<string> {
  const { sheetId } = await seedSheet(api, 1)
  expect((await importCsv(api, sheetId, csv, { replaceData: true })).ok()).toBeTruthy()
  return sheetId
}
async function run(sheetId: string, args: Record<string, unknown>): Promise<any> {
  const res = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { response_mapping: [{ json_path: '$.ok', column_name: 'OK' }], master_column_name: 'Call', ...args },
  })
  expect(res.status(), await res.text()).toBe(202)
  return res.json()
}
const rows = async (sheetId: string) =>
  ((await (await v1.get(`/api/v1/sheets/${sheetId}/rows`)).json()).rows as Array<{ data: Record<string, string> }>)
    .map(r => r.data)
const results = async (runId: string) => (await (await v1.get(`/api/v1/http-runs/${runId}/results`)).json()).results

test('a 503 is tried again until it works, and the response code column shows 200', async () => {
  rx.on('/flaky', { status: 503 }, { status: 503 }, { status: 200, body: '{"ok":"yes"}' })
  const sheetId = await sheetWith('Name\nAda\n')
  const r = await run(sheetId, { url: rx.url('/flaky?n={{Name}}'), status_code_column: 'Code' })
  expect((await waitForTerminal(v1, `/api/v1/http-runs/${r.run_id}`)).status).toBe('completed')
  expect(rx.hitsOn('/flaky')).toHaveLength(3)
  const [row] = await rows(sheetId)
  expect(row).toMatchObject({ OK: 'yes', Code: '200', Call: '✅ Success' })
})

test('Retry-After is followed, and a POST is retried on a 429', async () => {
  rx.on('/busy', { status: 429, headers: { 'Retry-After': '1' } }, { status: 200, body: '{"ok":"done"}' })
  const sheetId = await sheetWith('Name\nAda\n')
  const r = await run(sheetId, { url: rx.url('/busy'), method: 'POST', body: '{"n": "{{Name}}"}' })
  await waitForTerminal(v1, `/api/v1/http-runs/${r.run_id}`)
  const hits = rx.hitsOn('/busy')
  expect(hits).toHaveLength(2)
  expect(hits[1].at - hits[0].at).toBeGreaterThanOrEqual(950)
  expect((await rows(sheetId))[0].OK).toBe('done')
})

test('a 404 is not retried, and its row keeps the code', async () => {
  rx.on('/missing', { status: 404, body: '{"error":"nope"}' })
  const sheetId = await sheetWith('Name\nAda\n')
  const r = await run(sheetId, { url: rx.url('/missing'), status_code_column: 'Code' })
  await waitForTerminal(v1, `/api/v1/http-runs/${r.run_id}`)
  expect(rx.hitsOn('/missing')).toHaveLength(1)
  expect((await rows(sheetId))[0]).toMatchObject({ OK: '❌ Error', Code: '404', Call: '❌ Failed' })
})

test('a POST on a 500 is retried only when retry_post is on, and says how many tries it took', async () => {
  rx.on('/post500', { status: 500, body: '{"error":"boom"}' })
  const sheetId = await sheetWith('Name\nAda\n')
  const once = await run(sheetId, { url: rx.url('/post500'), method: 'POST', body: '{}' })
  await waitForTerminal(v1, `/api/v1/http-runs/${once.run_id}`)
  expect(rx.hitsOn('/post500')).toHaveLength(1)
  const other = await sheetWith('Name\nBo\n')
  const again = await run(other, { url: rx.url('/post500'), method: 'POST', body: '{}', retries: 2, retry_post: true })
  await waitForTerminal(v1, `/api/v1/http-runs/${again.run_id}`)
  expect(rx.hitsOn('/post500')).toHaveLength(4)
  const [res] = await results(again.run_id)
  expect(res.error_message).toMatch(/^HTTP 500 from upstream.*\(tried 3 times\)$/)
})

test('retries 0 turns them off', async () => {
  rx.on('/off', { status: 503 })
  const sheetId = await sheetWith('Name\nAda\n')
  const r = await run(sheetId, { url: rx.url('/off'), retries: 0 })
  await waitForTerminal(v1, `/api/v1/http-runs/${r.run_id}`)
  expect(rx.hitsOn('/off')).toHaveLength(1)
})

test('skip_empty_values leaves empty fields out; values are escaped in JSON and encoded in the query', async () => {
  rx.on('/echo', { status: 200, body: '{"ok":"seen"}' })
  const name = 'Bob "B" O\'Hara\\x'
  const sheetId = await sheetWith(`Email,Domain,Name\na+b@x.co,,"${name.replace(/"/g, '""')}"\n`)
  const r = await run(sheetId, {
    url: rx.url('/echo?email={{Email}}&domain={{Domain}}'), method: 'POST', skip_empty_values: true,
    headers: { 'Content-Type': 'application/json' },
    body: '{"email": "{{Email}}", "domain": "{{Domain}}", "name": "{{Name}}", "count": 3}',
  })
  expect((await waitForTerminal(v1, `/api/v1/http-runs/${r.run_id}`)).status).toBe('completed')
  const [hit] = rx.hitsOn('/echo')
  expect(hit.query.get('email')).toBe('a+b@x.co')
  expect(hit.query.has('domain')).toBe(false)
  expect(JSON.parse(hit.body)).toEqual({ email: 'a+b@x.co', name, count: 3 })
})

test('pausing while a row waits to retry stops it; resume carries on; cancel sends nothing more', async () => {
  rx.on('/slow', { status: 503, headers: { 'Retry-After': '30' } })
  const sheetId = await sheetWith('Name\nAda\n')
  const r = await run(sheetId, { url: rx.url('/slow') })
  await rx.waitFor('/slow', 1)
  expect((await v1.post(`/api/v1/http-runs/${r.run_id}/pause`)).ok()).toBeTruthy()
  await new Promise(res => setTimeout(res, 2500))
  expect(rx.hitsOn('/slow')).toHaveLength(1)
  expect((await (await v1.get(`/api/v1/http-runs/${r.run_id}`)).json()).status).toBe('paused')
  expect((await rows(sheetId))[0].Call).toBe('⏳ Processing...')
  expect((await v1.post(`/api/v1/http-runs/${r.run_id}/resume`)).ok()).toBeTruthy()
  await rx.waitFor('/slow', 2)
  expect((await v1.post(`/api/v1/http-runs/${r.run_id}/cancel`)).ok()).toBeTruthy()
  expect((await waitForTerminal(v1, `/api/v1/http-runs/${r.run_id}`)).status).toBe('cancelled')
  await new Promise(res => setTimeout(res, 2500))
  expect(rx.hitsOn('/slow')).toHaveLength(2)
})

test('the SSRF guard still refuses loopback, and never retries it', async () => {
  for (const url of [`http://127.0.0.1:${rx.port}/flaky`, `http://localhost:${rx.port}/flaky`]) {
    const sheetId = await sheetWith('Name\nAda\n')
    const before = rx.hits.length
    const r = await run(sheetId, { url })
    await waitForTerminal(v1, `/api/v1/http-runs/${r.run_id}`)
    const [res] = await results(r.run_id)
    expect(res.error_message).toMatch(/private\/internal address/)
    expect(rx.hits.length).toBe(before)
  }
})
