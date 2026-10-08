import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, getSheet } from './helpers'
import { mockTreg } from './helpers-treg'
import { freshTreg, rowsOf, seedLeadRows, startRun, verifiedEmailRun, waitRun } from './helpers-enrich'
import { autorunOf, autorunRuns, byName, seedViaWebhook, setAutorun, sleep, waitRow } from './helpers-autorun'

// Auto-run on an enrichment column (plan Features F; Verification 9, 20, 26):
// rows a webhook adds are enriched on their own, also after a tail delete lets
// an append reuse a position; the column's daily cap stops it; a row missing
// an input gets no status until the input is filled; an edit on a row already
// run never runs it again; fixing the input of a ❌ row runs it again, and so
// does writing the same input again (a fresh ask, not treg's kept failure).

const COL = 'Work email'
const ok = (r: Record<string, string>) => (r[COL] ?? '').startsWith('✅')
const calls = async () => (await mockTreg.requests()).filter(q => q.path.startsWith('/call/')).length

async function enrichedSheet(api: APIRequestContext, leads: Array<{ Name: string; Website: string }>) {
  const { sheetId } = await seedLeadRows(api, leads)
  await waitRun(api, await startRun(api, sheetId, verifiedEmailRun()), ['completed'])
  return sheetId
}

async function edit(api: APIRequestContext, sheetId: string, rowIndex: number, columnName: string, value: string) {
  const res = await api.put(`/api/sheets/${sheetId}/data`, { data: { updates: [{ rowIndex, columnName, value }] } })
  expect(res.ok()).toBeTruthy()
}

test('webhook rows auto-enrich; a tail delete then an append is still swept; the daily cap stops it', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId, deliver } = await seedViaWebhook(api, [{ Name: 'Maya Chen', Website: 'stripe.com' }])
  await waitRun(api, await startRun(api, sheetId, verifiedEmailRun()), ['completed'])
  await setAutorun(api, sheetId, { column: COL, enabled: true, dailyCapUsd: 1 })

  await deliver({ Name: 'Leo Martins', Website: 'notion.so' })
  await waitRow(api, sheetId, byName('Leo Martins'), ok)

  // Delete that last row: the next delivery lands on its position and is still new.
  const sheet = await getSheet(api, sheetId)
  const leo = (sheet.data.rows as Array<{ rowIndex: number; data: Record<string, string> }>)
    .find(r => r.data.Name === 'Leo Martins')!
  const del = await api.post(`/api/sheets/${sheetId}/rows/bulk-delete`, {
    data: { rowIndices: [leo.rowIndex], rowGeneration: sheet.sheet.row_generation ?? 0 },
  })
  expect(del.ok()).toBeTruthy()
  await deliver({ Name: 'Ada Lovelace', Website: 'figma.com' })
  const ada = await waitRow(api, sheetId, byName('Ada Lovelace'), ok)
  expect(ada.Email).toContain('@figma.com')

  // A cap below what one row can cost: auto-run pauses instead of running.
  await setAutorun(api, sheetId, { column: COL, enabled: true, dailyCapUsd: 0.0001 })
  const before = autorunRuns(sheetId).length
  await deliver({ Name: 'Grace Hopper', Website: 'airtable.com' })
  await expect.poll(async () => (await autorunOf(api, sheetId, COL)).pausedReason, { timeout: 10_000 })
    .toBe('column_cap')
  expect((await autorunOf(api, sheetId, COL)).pausedMessage).toContain("cap for this column")
  await sleep(1500)
  expect(autorunRuns(sheetId).length).toBe(before)
  expect((await rowsOf(api, sheetId)).find(byName('Grace Hopper'))?.[COL] ?? '').toBe('')
  await api.dispose()
})

test('missing inputs wait for their input; edits on rows already run never run them; a fixed ❌ row runs again',
  async () => {
    test.setTimeout(90_000)
    const api = await authedApi()
    await freshTreg(api, { badDomains: ['ramp.com'] })
    const sheetId = await enrichedSheet(api, [
      { Name: 'Maya Chen', Website: 'stripe.com' }, { Name: 'Kenji Mori', Website: '' },
      { Name: 'Omar Haddad', Website: 'ramp.com' },
    ])
    const rows = await rowsOf(api, sheetId)
    expect(rows[0][COL]).toMatch(/^✅/)
    expect(rows[1][COL] ?? '').toBe('')             // missing input: no status at all
    expect(rows[2][COL]).toMatch(/^❌/)
    await setAutorun(api, sheetId, { column: COL, enabled: true, dailyCapUsd: 1 })

    // An edit on a row that already ran: no call, no run.
    const calls0 = await calls()
    const runs0 = autorunRuns(sheetId).length
    await edit(api, sheetId, 0, 'Name', 'Maya C. Chen')
    await edit(api, sheetId, 0, 'Website', 'stripe.com/about')
    await sleep(2500)
    expect(await calls()).toBe(calls0)
    expect(autorunRuns(sheetId).length).toBe(runs0)

    // Filling the missing input runs the row.
    await edit(api, sheetId, 1, 'Website', 'linear.app')
    const kenji = await waitRow(api, sheetId, byName('Kenji Mori'), ok)
    expect(kenji.Email).toContain('@linear.app')

    // Fixing the bad input of a ❌ row runs it again.
    await edit(api, sheetId, 2, 'Website', 'retool.com')
    const omar = await waitRow(api, sheetId, byName('Omar Haddad'), ok)
    expect(omar.Email).toContain('@retool.com')
    expect((await rowsOf(api, sheetId))[0][COL]).toMatch(/^✅/)
    await api.dispose()
  })

test("an auto-run ❌ row written again with the same input asks treg afresh, not its kept failure", async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api, { badDomains: ['ramp.com'] })
  const { sheetId, deliver } = await seedViaWebhook(api, [{ Name: 'Maya Chen', Website: 'stripe.com' }])
  await waitRun(api, await startRun(api, sheetId, verifiedEmailRun()), ['completed'])
  await setAutorun(api, sheetId, { column: COL, enabled: true, dailyCapUsd: 1 })
  await deliver({ Name: 'Omar Haddad', Website: 'ramp.com' })
  await waitRow(api, sheetId, byName('Omar Haddad'), r => (r[COL] ?? '').startsWith('❌'))

  // treg keeps that refusal under the row's key: the same request would get it back.
  await mockTreg.set({ badDomains: [] })
  const sheet = await getSheet(api, sheetId)
  const omar = (sheet.data.rows as Array<{ rowIndex: number; data: Record<string, string> }>)
    .find(r => r.data.Name === 'Omar Haddad')!
  await edit(api, sheetId, omar.rowIndex, 'Website', 'ramp.com')
  const fixed = await waitRow(api, sheetId, byName('Omar Haddad'), ok)
  expect(fixed.Email).toContain('@ramp.com')
  // It walked to the step's next key (enrich-step.ts): "<attempt>.2".
  const keys = (await mockTreg.requests()).map(q => q.headers['idempotency-key'] ?? '')
  expect(keys.some(k => /^cbx1:a:[^:]+:[^:]+:[a-z]\d+\.2:/.test(k))).toBe(true)
  await api.dispose()
})
