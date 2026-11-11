import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet, importCsv } from './helpers'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'
import { Receiver } from './helpers-receiver'

// A cell holding U+0080-U+009F used in an HTTP API column's URL, a header and
// the body: what goes out, as bytes on the wire. The run completes, nothing is
// refused, and each place carries the cell as it is.

const rx = new Receiver()
let api: APIRequestContext
let v1: APIRequestContext

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await rx.start()
  api = await authedApi()
  v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'garbled http spec'))
})
test.afterAll(async () => { await rx.stop(); await v1?.dispose() })

const VALUES = ['a\u0085b', 'FraudFighterâ\u0084¢']

test('C1 cells in the URL, a header and the JSON body of an HTTP API column', async () => {
  rx.on('/c1', { status: 200, body: '{"ok":"yes"}' })
  const { sheetId } = await seedSheet(api, 1)
  expect((await importCsv(api, sheetId, `Name\n${VALUES.join('\n')}\n`, { replaceData: true })).ok()).toBeTruthy()
  const res = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: {
      url: rx.url('/c1?n={{Name}}'), method: 'POST', headers: { 'X-Name': '{{Name}}' }, body: '{"n": "{{Name}}"}',
      response_mapping: [{ json_path: '$.ok', column_name: 'OK' }], master_column_name: 'Call',
    },
  })
  expect(res.status(), await res.text()).toBe(202)
  const run = await res.json()
  const done = await waitForTerminal(v1, `/api/v1/http-runs/${run.run_id}`)
  expect(done.status).toBe('completed')
  const rows = (await (await v1.get(`/api/v1/sheets/${sheetId}/rows`)).json()).rows as Array<{ data: any }>
  expect(rows.map(r => r.data)).toEqual(VALUES.map(Name => ({ Name, Call: '✅ Success', OK: 'yes' })))

  const hits = rx.hitsOn('/c1')
  expect(hits).toHaveLength(2)
  const hitOf = (v: string) => hits.find(h => h.query.get('n') === v)!
  // The URL: the cell's UTF-8, percent-encoded.
  expect(hitOf(VALUES[0]).url).toBe('/c1?n=a%C2%85b')
  expect(hitOf(VALUES[1]).url).toBe('/c1?n=FraudFighter%C3%A2%C2%84%C2%A2')
  // The header: each character as its one byte, the way header values carry U+0000-U+00FF (é is E9 too).
  const headerHex = (v: string) => Buffer.from(String(hitOf(v).headers['x-name']), 'latin1').toString('hex')
  expect(headerHex(VALUES[0])).toBe('618562')
  expect(headerHex(VALUES[1])).toBe(Buffer.from('FraudFighter\xE2\x84\xA2', 'latin1').toString('hex'))
  // The JSON body: the cell's UTF-8 inside the string (C2 85 for U+0085), which parses to the same value.
  for (const v of VALUES) {
    expect(hitOf(v).raw.toString('hex')).toBe(Buffer.from(`{"n": "${v}"}`, 'utf8').toString('hex'))
    expect(JSON.parse(hitOf(v).body).n).toBe(v)
  }
})
