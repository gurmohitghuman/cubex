import { test, expect } from '@playwright/test'
import { authedApi } from './helpers'
import { freshTreg, readDb, rowsOf, startRun, waitRun } from './helpers-enrich'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'
import { byName, seedViaWebhook, setAutorun, sleep, waitRow } from './helpers-autorun'

// A chain of auto-runs (plan Features F; Verification 9): a webhook adds a
// row, "Find email" fills Email, which fills "Verify"'s input, whose Email
// status fills the HTTP push's "Only run if": each column runs once per row,
// on its own. The push sends a real request (jsonplaceholder) only where the
// status is valid, and its auto-runs keep the saved-key policy of the run
// they repeat: a run started without the 'secrets' scope stays without it.

const POSTS = 'https://jsonplaceholder.typicode.com/posts'
const base = {
  continueColumn: false, cleanDomains: true, providerOrder: [], skipProviders: [], stopAtFirst: false, email: null,
  rows: { mode: 'all', test: false }, conditions: [], maxCostPerRowUsd: null, spendLimitUsd: null, fresh: false,
}

test('webhook -> find email -> verify -> HTTP push only if valid; HTTP auto-run keeps allow_secrets', async () => {
  test.setTimeout(150_000)
  const api = await authedApi()
  // Each finder answers first.last@domain; Grace's address is judged invalid.
  await freshTreg(api, { sameEmail: ['stripe', 'figma', 'notion'], verdicts: { 'grace.hopper@notion.so': 'invalid' } })
  const { sheetId, deliver } = await seedViaWebhook(api, [{ Name: 'Maya Chen', Website: 'stripe.com' }])
  const maya = async () => (await rowsOf(api, sheetId)).find(byName('Maya Chen'))!

  await waitRun(api, await startRun(api, sheetId, {
    ...base, toolId: 'treg.people.email.find', preset: null, columnName: 'Find email',
    inputs: { full_name: { column: 'Name' }, domain: { column: 'Website' } },
    outputs: [{ key: 'email', path: '$.output.email', columnName: 'Email' }],
  }), ['completed'])
  await waitRun(api, await startRun(api, sheetId, {
    ...base, toolId: 'treg.people.email.verify', preset: null, columnName: 'Verify', cleanDomains: false,
    inputs: { email: { column: 'Email' } },
    outputs: [{ key: 'status', path: '$.output.status', columnName: 'Email status' }],
  }), ['completed'])
  expect((await maya())['Email status']).toBe('valid')

  // The push, started by an agent token without the 'secrets' scope (allow_secrets 0).
  const v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e auto-run push'))
  const started = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: {
      master_column_name: 'Push',
      config: {
        requestConfig: { method: 'POST', url: POSTS, headers: { 'Content-Type': 'application/json' },
          body: '{"email": "{{Email}}"}' },
        responseMapping: [{ jsonPath: '$.id', columnName: 'Post id' }],
      },
    },
  })
  expect(started.status()).toBe(202)
  await waitForTerminal(v1, `/api/v1/http-runs/${(await started.json()).run_id}`)
  expect((await maya()).Push).toMatch(/^✅/)

  await setAutorun(api, sheetId, { column: 'Find email', enabled: true, dailyCapUsd: 1 })
  await setAutorun(api, sheetId, { column: 'Verify', enabled: true, dailyCapUsd: 1 })
  await setAutorun(api, sheetId, {
    column: 'Push', enabled: true, dailyRowCap: 10, where: [{ column: 'Email status', op: 'eq', value: 'valid' }],
  })

  await deliver({ Name: 'Ada Lovelace', Website: 'figma.com' })
  await deliver({ Name: 'Grace Hopper', Website: 'notion.so' })

  const ada = await waitRow(api, sheetId, byName('Ada Lovelace'), r => (r.Push ?? '').startsWith('✅'), 60_000)
  expect(ada.Email).toBe('ada.lovelace@figma.com')
  expect(ada['Email status']).toBe('valid')
  expect(ada['Post id']).toBe('101')

  // Grace's address is invalid: found and checked, never pushed.
  const grace = await waitRow(api, sheetId, byName('Grace Hopper'), r => r['Email status'] === 'invalid', 30_000)
  expect(grace.Email).toBe('grace.hopper@notion.so')
  await sleep(2500)
  expect((await rowsOf(api, sheetId)).find(byName('Grace Hopper'))?.Push ?? '').toBe('')

  // Every column ran once per row: one Find email, one Verify and one Push auto-run row each.
  const runs = readDb(db => db.prepare(`SELECT master_column_name AS c, total_rows AS n, allow_secrets AS s
    FROM http_runs WHERE sheet_id = ? AND autorun_id IS NOT NULL`).all(sheetId)) as
    Array<{ c: string; n: number; s: number }>
  const rowsFor = (c: string) => runs.filter(r => r.c === c).reduce((sum, r) => sum + r.n, 0)
  expect(rowsFor('Find email')).toBe(2)
  expect(rowsFor('Verify')).toBe(2)
  expect(rowsFor('Push')).toBe(1)
  // The push's auto-runs never got more than the run they repeat: no saved keys.
  expect(runs.filter(r => r.c === 'Push').every(r => r.s === 0)).toBe(true)
  await v1.dispose(); await api.dispose()
})
