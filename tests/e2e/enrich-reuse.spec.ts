import { test, expect, Page, APIRequestContext } from '@playwright/test'
import { authedApi, BASE, importCsv, makeAccessToken } from './helpers'
import { mockTreg } from './helpers-treg'
import { freshTreg, ledger, resultsOf, rowsOf, seedLeadRows } from './helpers-enrich'

// Found answers are reused across runs and sheets: a second sheet's rows whose
// lookup the first sheet's run found fill from those answers with no call, no
// ledger row and no cost; the estimate (REST and the drawer) counts them; the
// row says where its answer came from; "Always call again" (fresh) and 0 days
// in Settings call every row again.

const ADA = { Name: 'Ada Lovelace', Website: 'acme.example' }
const GRACE = { Name: 'Grace Hopper', Website: 'navy.example' }
const SECOND = ['Name,Website', 'Ada Lovelace,acme.example', 'Grace Hopper,navy.example', 'Lin Wu,lin.example']
const EMAIL_RUN = {
  tool_id: 'treg.people.email.find', preset: 'verified_email', inputs: { full_name: 'Name', domain: 'Website' },
  email: { guess: false },
}
const finds = async () => (await mockTreg.requests())
  .filter(r => r.path === '/call/treg.people.email.find').map(r => JSON.parse(r.body).full_name as string)
// Every call (finds, checks, a free guess's check) about someone, after the first `from` calls.
const callsAbout = async (who: string, from: number) => (await mockTreg.requests())
  .filter(r => r.path.startsWith('/call/')).slice(from).filter(r => r.body.toLowerCase().includes(who)).length
const allCalls = async () => (await mockTreg.requests()).filter(r => r.path.startsWith('/call/')).length
const reuseDays = (api: APIRequestContext, days: number) =>
  api.put('/api/settings/enrich-reuse', { data: { days } }).then(r => expect(r.ok()).toBeTruthy())
const drawer = (page: Page) => page.getByTestId('enrich-drawer')

// Two sheets of one table: the first with Ada, Grace and someone nobody finds;
// the second with Ada and Grace again and Lin, new.
async function twoSheets(api: APIRequestContext) {
  const nobody = { Name: 'Nobody Here', Website: 'quiet.example' }
  const { tableId, sheetId: first } = await seedLeadRows(api, [ADA, GRACE, nobody])
  const made = await (await api.post(`/api/tables/${tableId}/sheets`, { data: { name: 'Second' } })).json()
  const second = made.sheet.id as string
  expect((await importCsv(api, second, SECOND.join('\n'), { replaceData: true, filename: 'second.csv' })).ok())
    .toBeTruthy()
  return { tableId, first, second }
}

test('REST: rows found on another sheet are reused at no cost, unless fresh or reuse is off', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  await reuseDays(api, 30)
  const { first, second } = await twoSheets(api)
  const headers = { Authorization: `Bearer ${await makeAccessToken(api, ['read', 'write', 'run'], 'e2e reuse')}` }
  const run = async (sheetId: string, extra: Record<string, unknown>) => {
    const res = await api.post(`/api/v1/sheets/${sheetId}/enrichment-runs`,
      { headers, data: { ...EMAIL_RUN, ...extra } })
    const body = await res.json()
    if (extra.estimate_only) return body
    expect(res.status(), JSON.stringify(body)).toBe(202)
    const statusOf = async () => (await (await api.get(`/api/v1/http-runs/${body.run_id}`, { headers })).json()).status
    await expect.poll(statusOf, { timeout: 30_000 }).toBe('completed')
    return body
  }
  const a = await run(first, { column_name: 'Work email' })
  expect((await rowsOf(api, first)).map(r => r['Work email'])).toEqual(['✅ Valid', '✅ Valid', '⏭️ Not found'])

  // The estimate counts the rows that reuse and prices the rest.
  const est = await run(second, { column_name: 'Work email', estimate_only: true })
  expect(est.rows_to_process).toBe(3)
  expect(est.reuse).toMatchObject({ rows: 2, complete: true, days: 30, fresh: false })
  const priced = await run(second, { column_name: 'Work email', estimate_only: true, fresh: true })
  expect(priced.reuse.rows).toBe(0)
  expect(est.estimated_cost_usd.high).toBeLessThan(priced.estimated_cost_usd.high)

  const before = (await finds()).length
  const b = await run(second, { column_name: 'Work email' })
  expect((await finds()).slice(before)).toEqual(['Lin Wu'])
  expect((await rowsOf(api, second)).map(r => r['Work email'])).toEqual(['✅ Valid', '✅ Valid', '✅ Valid'])
  expect((await rowsOf(api, second))[0].Email).toBe((await rowsOf(api, first))[0].Email)
  // Lin's find and check are the run's only ledger rows; the reused rows cost nothing.
  expect(ledger(b.run_id)).toHaveLength(2)
  const results = resultsOf(b.run_id)
  expect(results[0].cost_usd).toBe(0)
  expect(results[0].response._cubex.reused_from.run_id).toBe(a.run_id)
  const status = await (await api.get(`/api/v1/http-runs/${b.run_id}`, { headers })).json()
  expect(status.enrichment.reused_rows).toBe(2)
  const page1 = await (await api.get(`/api/v1/http-runs/${b.run_id}/results`, { headers })).json()
  expect(page1.results[0].reused_answer_from).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
  expect(page1.results[2].reused_answer_from).toBeUndefined()
  const answer = await (await api.get(`/api/enrich/sheets/${second}/answer`,
    { params: { column: 'Work email', row: 0 } })).json()
  expect(answer.enrichment.reused).toMatchObject({ sheetId: first, sheetName: 'Sheet1' })
  expect(answer.enrichment.calls).toHaveLength(0)

  // The column menu's "Run all rows again": every row reuses a found answer, so nothing to pay.
  const rerun = await (await api.post(`/api/enrich/sheets/${second}/reruns`,
    { data: { column: 'Work email', mode: 'all', status: 'any', estimateOnly: true } })).json()
  expect(rerun.estimate).toMatchObject({ rows: 3, reusedRows: 3, reuseComplete: true, highUsd: 0 })

  // fresh: every row calls again.
  const only = (name: string) => ({ outputs: [{ field: 'email', column_name: name }] })
  await run(second, { column_name: 'Fresh email', fresh: true, ...only('Fresh address') })
  expect((await finds()).slice(before + 1).sort()).toEqual(['Ada Lovelace', 'Grace Hopper', 'Lin Wu'])
  // 0 days in Settings: every row calls too.
  await reuseDays(api, 0)
  await run(second, { column_name: 'Off email', ...only('Off address') })
  expect((await finds()).length).toBe(before + 1 + 3 + 3)
  expect((await api.put('/api/settings/enrich-reuse', { data: { days: 400 } })).status()).toBe(400)
  await reuseDays(api, 30)
})

test('the drawer counts reused rows before the run, the run says how many, the panel says from where',
  async ({ page, context }) => {
    test.setTimeout(150_000)
    const api = await authedApi()
    await freshTreg(api)
    await reuseDays(api, 30)
    const { tableId } = await twoSheets(api)
    await context.addCookies((await api.storageState()).cookies)
    await page.goto(`${BASE}/table/${tableId}`)
    await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
    const runAll = async (count: string) => {
      await page.getByRole('button', { name: 'Enrichment', exact: true }).click()
      await drawer(page).getByTestId('enrich-tool-card').filter({ hasText: 'Verified work email' }).click()
      await expect(drawer(page).getByTestId('enrich-run-all')).toHaveText(`Run all ${count}`, { timeout: 15_000 })
    }
    await runAll('3')
    await expect(drawer(page).getByTestId('enrich-reuse-line')).toHaveCount(0)
    await drawer(page).getByTestId('enrich-run-all').click()
    await page.getByRole('dialog').filter({ hasText: 'Run the enrichment' })
      .getByRole('button', { name: 'Run' }).click()
    await expect(drawer(page).getByTestId('enrich-run-headline')).toContainText('Ran', { timeout: 30_000 })
    await drawer(page).getByTestId('enrich-view-results').click()

    await page.getByRole('button', { name: 'Second', exact: true }).click()
    await expect(page.getByText('Lin Wu', { exact: true })).toBeVisible({ timeout: 15_000 })
    await runAll('3')
    await expect(drawer(page).getByTestId('enrich-reuse-line'))
      .toHaveText('2 rows reuse answers found in the last 30 days, at no cost. '
        + 'The estimate covers the other 1 row.', { timeout: 15_000 })
    await drawer(page).getByText('Rows and limits', { exact: true }).click()
    await expect(drawer(page).getByTestId('enrich-call-again')).not.toBeChecked()
    await expect(drawer(page)).toContainText('reuses that answer for free')
    await drawer(page).getByTestId('enrich-run-all').click()
    const confirm = page.getByRole('dialog').filter({ hasText: 'Run the enrichment' })
    await expect(confirm).toContainText('2 rows reuse earlier answers at no cost.')
    const before = await allCalls()
    await confirm.getByRole('button', { name: 'Run' }).click()
    await expect(drawer(page).getByTestId('enrich-run-reused')).toHaveText('2 rows reused earlier answers, at no cost.',
      { timeout: 30_000 })
    await expect(drawer(page).getByTestId('enrich-run-headline')).toContainText('Ran', { timeout: 30_000 })
    expect(await callsAbout('ada', before) + await callsAbout('grace', before)).toBe(0)
    expect(await callsAbout('lin', before)).toBeGreaterThan(0)

    // The answer panel says where the answer came from.
    await drawer(page).getByTestId('enrich-view-results').click()
    const header = page.locator('.ag-header-cell').filter({ hasText: 'Verified work email' }).first()
    const colId = await header.getAttribute('col-id')
    await page.locator(`.ag-row[row-index="0"] .ag-cell[col-id="${colId}"]`).first().click()
    await expect(page.getByTestId('answer-cost'))
      .toHaveText(/^Reused an answer found on \d{4}-\d\d-\d\d in Sheet1: no call, no cost\.$/, { timeout: 15_000 })

    // "Rerun this row" calls treg again for it, not the earlier answer.
    const calledBefore = await allCalls()
    await page.getByTestId('answer-rerun').click()
    const rerun = page.getByRole('dialog').filter({ hasText: 'Run selected rows' })
    await expect(rerun).toContainText('Its current result is replaced, and it costs again.', { timeout: 15_000 })
    await expect(rerun).not.toContainText('reuse')
    await rerun.getByRole('button', { name: 'Run' }).click()
    await expect.poll(() => callsAbout('ada', calledBefore), { timeout: 30_000 }).toBeGreaterThan(0)

    // A sheet whose rows all reuse: the run starts (no $0 run limit) and fills them for free.
    const third = (await (await api.post(`/api/tables/${tableId}/sheets`, { data: { name: 'Third' } })).json()).sheet.id
    const both = ['Name,Website', 'Ada Lovelace,acme.example', 'Grace Hopper,navy.example'].join('\n')
    expect((await importCsv(api, third, both, { replaceData: true, filename: 'third.csv' })).ok()).toBeTruthy()
    await page.reload()
    await page.getByRole('button', { name: 'Third', exact: true }).click()
    await expect(page.getByText('Grace Hopper', { exact: true })).toBeVisible({ timeout: 15_000 })
    await runAll('2')
    await expect(drawer(page).getByTestId('enrich-reuse-line'))
      .toHaveText('All 2 rows reuse answers found in the last 30 days, at no cost.', { timeout: 15_000 })
    await drawer(page).getByTestId('enrich-run-all').click()
    const free = page.getByRole('dialog').filter({ hasText: 'Run the enrichment' })
    await expect(free).toContainText('2 rows reuse earlier answers at no cost.')
    await expect(free).not.toContainText('The run stops at $0.00')
    const beforeFree = await allCalls()
    await free.getByRole('button', { name: 'Run' }).click()
    await expect(drawer(page).getByTestId('enrich-run-reused')).toHaveText('2 rows reused earlier answers, at no cost.',
      { timeout: 30_000 })
    expect(await allCalls()).toBe(beforeFree)
  })

test('Settings: the days answers are reused for, changed and turned off', async ({ page, context }) => {
  const api = await authedApi()
  await reuseDays(api, 30)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/settings/http-enrichment`)
  const box = page.getByTestId('enrich-reuse-days')
  await expect(box).toContainText('Reuse found answers: 30 days', { timeout: 15_000 })
  await box.getByRole('button', { name: 'Change' }).click()
  await box.getByLabel('Days to reuse found answers').fill('0')
  await box.getByRole('button', { name: 'Save' }).click()
  await expect(box).toContainText('Reuse found answers: off')
  expect((await (await api.get('/api/settings/enrich-reuse')).json()).days).toBe(0)
  await box.getByRole('button', { name: 'Change' }).click()
  await box.getByLabel('Days to reuse found answers').fill('7')
  await box.getByRole('button', { name: 'Save' }).click()
  await expect(box).toContainText('Reuse found answers: 7 days')
  await reuseDays(api, 30)
})
