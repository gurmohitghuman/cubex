import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi } from './helpers'
import { mockTreg } from './helpers-treg'
import {
  expectSettledBilledOnce, freshTreg, rowsOf, runIdsOf, seedLeadRows, startRun, verifiedEmailRun, waitRun,
} from './helpers-enrich'
import {
  autorunOf, autorunRuns, byName, moveClock, seedViaWebhook, setAutorun, sleep, waitAutorunActive, waitNoActiveRun,
  waitRow,
} from './helpers-autorun'

// How auto-run stops (plan Features F, J; sec. 8; Verification 9, 14, 23):
// a sort while an auto-run run is on the sheet gets a 409 naming auto-run and
// the sheet yields, so the retry goes through; a daily-limit stop cancels the
// auto-run run (sort and edits work at once) and auto-run waits for midnight
// UTC (the harness's test clock); a person's cancel isn't picked up again; a
// run a person started that paused at its limit makes the sort 409 name it.

const COL = 'Work email'
const ok = (r: Record<string, string>) => (r[COL] ?? '').startsWith('✅')
const sort = (api: APIRequestContext, sheetId: string) =>
  api.post(`/api/sheets/${sheetId}/sort`, { data: { column: 'Name', direction: 'asc' } })

async function autorunSheet(api: APIRequestContext, run: Record<string, unknown> = {}) {
  const { sheetId, deliver } = await seedViaWebhook(api, [{ Name: 'Maya Chen', Website: 'stripe.com' }])
  await waitRun(api, await startRun(api, sheetId, verifiedEmailRun(run)), ['completed'])
  await setAutorun(api, sheetId, { column: COL, enabled: true, dailyCapUsd: 1 })
  return { sheetId, deliver }
}

test.afterEach(async () => { moveClock(0); await mockTreg.set({ delayMs: 0 }) })

test('a sort during auto-run gets the auto-run 409; the retry after the yield goes through', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId, deliver } = await autorunSheet(api)
  await mockTreg.set({ delayMs: 1500 })
  await deliver({ Name: 'Leo Martins', Website: 'notion.so' })
  await waitAutorunActive(sheetId)
  const blocked = await sort(api, sheetId)
  expect(blocked.status()).toBe(409)
  expect((await blocked.json()).error)
    .toBe('Auto-run is enriching 1 row in Work email. Try again in a moment, or pause auto-run.')

  // The small run ends; a row that arrives now waits out the yield, and the retry sorts.
  await waitNoActiveRun(sheetId)
  await mockTreg.set({ delayMs: 0 })
  await deliver({ Name: 'Ada Lovelace', Website: 'figma.com' })
  await sleep(1200)
  expect(autorunRuns(sheetId).filter(r => r.status !== 'completed')).toHaveLength(0)
  expect((await sort(api, sheetId)).status()).toBe(200)
  // The sort moved Ada before auto-run looked at her: she still runs once the yield ends.
  const ada = await waitRow(api, sheetId, byName('Ada Lovelace'), ok, 30_000)
  expect(ada.Email).toContain('@figma.com')
  expect((await rowsOf(api, sheetId)).map(r => r.Name).filter(Boolean))
    .toEqual(['Ada Lovelace', 'Leo Martins', 'Maya Chen'])
  await api.dispose()
})

test('the daily limit stops auto-run: its run cancels, sort and edits work at once, it waits for midnight UTC',
  async () => {
    test.setTimeout(120_000)
    const api = await authedApi()
    await freshTreg(api)
    const { sheetId, deliver } = await autorunSheet(api, { maxCostPerRowUsd: 0.01 })
    // Six rows arrive while auto-run is paused, so one run takes them all.
    expect((await api.post(`/api/autorun/sheets/${sheetId}/pause`, { data: { paused: true } })).ok()).toBeTruthy()
    const people = ['Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Hedy Lamarr', 'Kenji Mori', 'Leo Martins']
    for (const Name of people) await deliver({ Name, Website: 'figma.com' })
    await mockTreg.set({ delayMs: 1500 })
    expect((await api.post(`/api/autorun/sheets/${sheetId}/pause`, { data: { paused: false } })).ok()).toBeTruthy()
    const run = await waitAutorunActive(sheetId)
    expect(run.total_rows).toBe(6)

    // The first batch (five rows) is in flight; the limit drops under what is spent.
    expect((await api.put('/api/settings/enrich-daily-limit', { data: { limitUsd: 0.01 } })).ok()).toBeTruthy()
    await expect.poll(() => autorunRuns(sheetId).find(r => r.id === run.id)?.status, { timeout: 30_000 })
      .toBe('cancelled')
    expect(autorunRuns(sheetId).find(r => r.id === run.id)?.pause_reason).toBe('daily_limit')
    expect((await autorunOf(api, sheetId, COL)).pausedReason).toBe('daily_limit')
    await mockTreg.set({ delayMs: 0 })

    // The rows the run didn't reach went back to wait, with no status.
    const waiting = (await rowsOf(api, sheetId)).filter(r => people.includes(r.Name) && !ok(r)).map(r => r.Name)
    expect(waiting.length).toBeGreaterThan(0)
    expect((await rowsOf(api, sheetId)).filter(r => waiting.includes(r.Name)).every(r => (r[COL] ?? '') === ''))
      .toBe(true)

    // Nothing holds the sheet: sort and edits (an output column too) go through at once.
    expect((await sort(api, sheetId)).status()).toBe(200)
    const put = await api.put(`/api/sheets/${sheetId}/data`, {
      data: { updates: [{ rowIndex: 0, columnName: 'Email', value: 'checked@by.hand' }] },
    })
    expect(put.ok()).toBeTruthy()
    expect((await put.json()).lockedColumns).toEqual([])
    await sleep(2000)
    expect((await autorunOf(api, sheetId, COL)).pausedReason).toBe('daily_limit')

    // Midnight UTC: today's spend starts over and auto-run goes on with the rows it left.
    moveClock(24 * 3600 * 1000)
    const doneNow = async () => (await rowsOf(api, sheetId)).filter(r => waiting.includes(r.Name) && ok(r)).length
    await expect.poll(doneNow, { timeout: 30_000 }).toBeGreaterThan(0)
    await expectSettledBilledOnce(runIdsOf(sheetId))
    expect((await api.put('/api/settings/enrich-daily-limit', { data: { limitUsd: 10 } })).ok()).toBeTruthy()
    await api.dispose()
  })

test("a person's cancel of an auto-run run isn't picked up again", async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId, deliver } = await autorunSheet(api)
  await mockTreg.set({ delayMs: 2000 })
  await deliver({ Name: 'Leo Martins', Website: 'notion.so' })
  const run = await waitAutorunActive(sheetId)
  expect((await api.post(`/api/http/jobs/${run.id}/control`, { data: { action: 'cancel' } })).ok()).toBeTruthy()
  await expect.poll(async () => (await autorunOf(api, sheetId, COL)).pausedReason).toBe('user')
  await mockTreg.set({ delayMs: 0 })
  await waitNoActiveRun(sheetId)
  const count = autorunRuns(sheetId).length
  await deliver({ Name: 'Ada Lovelace', Website: 'figma.com' })
  await sleep(3000)
  expect(autorunRuns(sheetId).length).toBe(count)
  const rows = await rowsOf(api, sheetId)
  expect(rows.find(byName('Leo Martins'))?.[COL] ?? '').toBe('')
  expect(rows.find(byName('Ada Lovelace'))?.[COL] ?? '').toBe('')
  await expectSettledBilledOnce(runIdsOf(sheetId))
  await api.dispose()
})

test('a run a person started that paused at its limit makes the sort 409 name it, with "cancel it"', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedLeadRows(api, [
    { Name: 'Maya Chen', Website: 'stripe.com' }, { Name: 'Leo Martins', Website: 'notion.so' },
    { Name: 'Ada Lovelace', Website: 'figma.com' },
  ])
  const runId = await startRun(api, sheetId, verifiedEmailRun({ maxCostPerRowUsd: 0.01, spendLimitUsd: 0.01 }))
  await waitRun(api, runId, ['paused'])
  const blocked = await sort(api, sheetId)
  expect(blocked.status()).toBe(409)
  const body = await blocked.json()
  expect(body.error).toBe('The Work email run is paused. Resume it to finish, or cancel it, then try again.')
  expect(body.blockingRun).toMatchObject({ id: runId, kind: 'http', paused: true })
  expect((await api.post(`/api/http/jobs/${runId}/control`, { data: { action: 'cancel' } })).ok()).toBeTruthy()
  await waitNoActiveRun(sheetId)
  expect((await sort(api, sheetId)).status()).toBe(200)
  await expectSettledBilledOnce(runIdsOf(sheetId))
  await api.dispose()
})
