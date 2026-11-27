import { test, expect, type APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet, importCsv } from './helpers'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'
import { Receiver } from './helpers-receiver'

// An HTTP API column follows redirects (lib/http-redirect.ts) through Cubex's real outbound path: the guard runs on
// every hop, so a redirect to an address Cubex doesn't call is refused; on the same host the template's headers go
// along, to another host they don't; a loop stops after HTTP_MAX_REDIRECTS.
const rx = new Receiver()
let api: APIRequestContext
let v1: APIRequestContext

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await rx.start()
  api = await authedApi()
  v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'http redirects spec'))
})
test.afterAll(async () => { await rx.stop(); await v1?.dispose(); await api?.dispose() })

async function runOn(path: string): Promise<{ status: string; cells: Record<string, string>; results: string }> {
  const { sheetId } = await seedSheet(api, 1)
  expect((await importCsv(api, sheetId, 'Name\nAda\n', { replaceData: true })).ok()).toBeTruthy()
  const res = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, { data: {
    url: rx.url(`${path}?n={{Name}}`), headers: { 'X-Key': 'secret-for-api' }, master_column_name: 'Call',
    response_mapping: [{ json_path: '$.ok', column_name: 'OK' }],
  } })
  expect(res.status(), await res.text()).toBe(202)
  const runId = (await res.json()).run_id
  const done = await waitForTerminal(v1, `/api/v1/http-runs/${runId}`)
  const rows = (await (await v1.get(`/api/v1/sheets/${sheetId}/rows`)).json()).rows as Array<{ data: any }>
  // The row's error is on its result (the cell says ❌ Failed).
  const results = JSON.stringify(await (await v1.get(`/api/v1/http-runs/${runId}/results`)).json())
  return { status: done.status, cells: rows[0].data, results }
}

test('a redirect on the same host is followed, the headers with it', async () => {
  rx.on('/r-start', { status: 302, headers: { Location: '/r-end?moved=1' }, body: '' })
  rx.on('/r-end', { status: 200, body: '{"ok":"followed"}' })
  const { cells } = await runOn('/r-start')
  expect(cells.OK).toBe('followed')
  const end = rx.hitsOn('/r-end')
  expect(end).toHaveLength(1)
  expect(end[0].headers['x-key']).toBe('secret-for-api')
})

test('to another host it goes without the template\'s headers', async () => {
  rx.on('/x-start', { status: 301, headers: { Location: rx.url('/x-end', 'other') }, body: '' })
  rx.on('/x-end', { status: 200, body: '{"ok":"moved"}' })
  const { cells } = await runOn('/x-start')
  expect(cells.OK).toBe('moved')
  const end = rx.hitsOn('/x-end')
  expect(end).toHaveLength(1)
  expect(end[0].headers['x-key']).toBeUndefined()
})

test('a redirect to an address Cubex doesn\'t call is refused, and a loop stops', async () => {
  rx.on('/b-start', { status: 302, headers: { Location: `http://127.0.0.1:${rx.port}/b-end` }, body: '' })
  const blocked = await runOn('/b-start')
  expect(blocked.cells.Call).toBe('❌ Failed')
  expect(blocked.results).toMatch(/A redirect was refused/)
  expect(rx.hitsOn('/b-end')).toHaveLength(0)

  rx.on('/loop', { status: 307, headers: { Location: '/loop' }, body: '' })
  const loop = await runOn('/loop')
  expect(loop.results).toMatch(/More than 5 redirects/)
  expect(rx.hitsOn('/loop')).toHaveLength(6)
})
