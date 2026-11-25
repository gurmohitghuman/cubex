import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, importCsv } from './helpers'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'
import { Receiver } from './helpers-receiver'

// A GET's answer is kept for a while (lib/http-request.ts), but only within the run that asked: three rows asking
// the same thing in one run call the endpoint once; the column run again, it is called again, not answered from
// what the last run was told.
const rx = new Receiver()
test.beforeAll(async () => { await rx.start() })
test.afterAll(async () => { await rx.stop() })

test('an HTTP column run again calls the endpoint again for the same GET', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], `http-rerun-${Date.now()}`))
  const { sheetId } = await seedSheet(api, 1)
  expect((await importCsv(api, sheetId, 'Name\nA\nB\nC\n', { replaceData: true })).ok()).toBeTruthy()
  rx.on('/same', { status: 200, body: '{"ok":"yes"}' })
  const start = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, { data: {
    url: rx.url('/same'), master_column_name: 'Ping', batch_size: 1,
    response_mapping: [{ json_path: '$.ok', column_name: 'Ping OK' }],
  } })
  expect(start.status(), await start.text()).toBe(202)
  const runId = (await start.json()).run_id
  await waitForTerminal(v1, `/api/v1/http-runs/${runId}`)
  expect(rx.hitsOn('/same').length).toBe(1)

  const rerun = await v1.post(`/api/v1/http-runs/${runId}/rerun`, { data: { mode: 'all' } })
  expect(rerun.status(), await rerun.text()).toBeLessThan(300)
  const again = (await rerun.json()).run_id
  await waitForTerminal(v1, `/api/v1/http-runs/${again}`)
  expect(rx.hitsOn('/same').length).toBe(2)
  await v1.dispose()
})
