import { test, expect, APIRequestContext, Page } from '@playwright/test'
import { authedApi, BASE } from './helpers'
import { mockTreg } from './helpers-treg'
import { callEveryRow, freshTreg, rowsOf, seedCsv } from './helpers-enrich'
import { choose } from './helpers-ui'

// The waterfall drawer lists a treg step's providers, and an email check's verify providers, as the Enrichment
// drawer lists them. Run again from the drawer untouched, the step keeps its order and skips exactly, names the
// list doesn't show too; a provider switched off there is never asked (the stand-in logs every provider it asks).
const GUESS = "{{full_name}}.toLowerCase().replace(' ', '.') + '@' + {{domain}}"
const CHECK = {
  kind: 'verify', accept: 'safest', providerOrder: ['trykitt', 'nosuchverifier'], skipProviders: ['oldverifier'],
}
const FIND = {
  kind: 'enrichment', toolId: 'treg.people.email.find', inputs: { full_name: 'full_name', domain: 'domain' },
  providerOrder: ['hunter', 'nosuchfinder'], skipProviders: ['oldfinder'], stopAtFirst: false,
}
const drawer = (page: Page) => page.getByTestId('waterfall-drawer')
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `test-results/shots/${name}.png`, fullPage: true })
const asked = async (toolId: string) =>
  (await mockTreg.providers()).filter(p => p.toolId === toolId).map(p => p.provider)

callEveryRow()

// A waterfall of one step, run on the first row only so the drawer has rows left to run; then its sheet open.
async function seed(page: Page, api: APIRequestContext, step: Record<string, unknown>) {
  const { tableId, sheetId } = await seedCsv(api,
    'Name,Website\nMaya Chen,stripe.com\nLeo Martins,notion.so\nAva Patel,figma.com')
  const inputs = [
    { key: 'full_name', label: 'Full name', source: { column: 'Name' } },
    { key: 'domain', label: 'Company domain', source: { column: 'Website' } },
  ]
  const res = await api.post(`/api/waterfall/sheets/${sheetId}/runs`, { data: {
    columnName: 'Work email', resultType: 'email', inputs, fresh: true, rows: { mode: 'all', test: 1 },
    steps: [{ id: 'sdrawer', label: 'Step', ...step }],
  } })
  const run = await res.json()
  expect(res.ok(), JSON.stringify(run)).toBeTruthy()
  await expect.poll(async () => (await (await api.get(`/api/waterfall/runs/${run.runId}`)).json()).status,
    { timeout: 30_000 }).toBe('completed')
  await page.context().addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  const stepOf = async () => (await (await api.get(
    `/api/waterfall/sheets/${sheetId}/column-setup?column=Work%20email`)).json()).input.steps[0]
  return { sheetId, stepOf }
}

// Edit Waterfall, the step open, its providers list open: the switch of one provider.
async function openProviders(page: Page, list: RegExp, provider: string) {
  await page.locator('.ag-header-cell').filter({ hasText: 'Work email' }).first().locator('.ag-header-cell-text')
    .first().click()
  await page.getByText('Edit Waterfall').click()
  await expect(drawer(page).getByTestId('waterfall-step')).toHaveCount(1)
  await drawer(page).getByTestId('waterfall-step').getByRole('button', { name: /^Step/ }).click()
  await drawer(page).getByRole('button', { name: list }).click()
  return drawer(page).getByTestId('waterfall-providers').getByRole('switch', { name: `Use ${provider}` })
}

// Run from the drawer; the request it sent.
async function runAll(page: Page, sheetId: string) {
  await expect(drawer(page).getByTestId('waterfall-estimate')).toContainText('a row on average', { timeout: 15_000 })
  const sent = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith(`/sheets/${sheetId}/runs`))
  await drawer(page).getByRole('button', { name: 'Run', exact: true }).click()
  await page.getByRole('button', { name: 'Run', exact: true }).last().click()
  await expect(drawer(page).getByTestId('waterfall-run'))
    .toHaveAttribute('data-status', 'completed', { timeout: 30_000 })
  await drawer(page).getByRole('button', { name: 'Done' }).click()
  // Done goes back to the setup; Escape then closes the drawer (pressed again if a busy machine lost it).
  await expect(drawer(page).getByTestId('waterfall-step')).toHaveCount(1)
  await expect(async () => {
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toBeHidden({ timeout: 1_000 })
  }).toPass({ timeout: 10_000 })
  return (await sent).postDataJSON().steps[0]
}

test('an email check\'s providers in the drawer: kept when untouched, one switched off never asked',
  async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 1600, height: 1000 })
    const verify = 'treg.people.email.verify'
    const api = await authedApi()
    await freshTreg(api)
    const { sheetId, stepOf } = await seed(page, api, { choices: { kind: 'formula', formula: GUESS }, check: CHECK })
    expect(await asked(verify)).toEqual(['trykitt'])           // the check's order: Kitt AI first, and it answers

    // Untouched: the run sends the check as it was, a name the list doesn't show included.
    const kitt = await openProviders(page, /^Verify providers/, 'Kitt AI')
    await expect(kitt).toHaveAttribute('aria-checked', 'true')
    await shot(page, 'waterfall-verify-providers')
    expect((await runAll(page, sheetId)).check).toEqual(CHECK)
    expect((await stepOf()).check).toEqual(CHECK)
    expect(await asked(verify)).toEqual(['trykitt', 'trykitt', 'trykitt'])

    // Kitt AI (trykitt) switched off, every row again: never asked, though the check's order puts it first.
    const again = await openProviders(page, /^Verify providers/, 'Kitt AI')
    await again.click()
    await expect(again).toHaveAttribute('aria-checked', 'false')
    await choose(drawer(page).getByLabel('Which of its rows'), 'any')
    const before = (await asked(verify)).length
    await runAll(page, sheetId)
    const after = (await asked(verify)).slice(before)
    expect(after.length).toBeGreaterThanOrEqual(3)
    expect(after).not.toContain('trykitt')
    expect((await stepOf()).check).toEqual({ ...CHECK, skipProviders: ['oldverifier', 'trykitt'] })
    expect((await rowsOf(api, sheetId)).map(r => r['Work email']))
      .toEqual(['maya.chen@stripe.com', 'leo.martins@notion.so', 'ava.patel@figma.com'])
    await api.dispose()
  })

test('a treg step\'s providers in the drawer: kept when untouched, one switched off never asked', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1600, height: 1000 })
  const find = FIND.toolId
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId, stepOf } = await seed(page, api, { choices: FIND })
  expect(await asked(find)).toEqual(['hunter'])

  const hunter = await openProviders(page, /^Providers/, 'Hunter')
  await expect(hunter).toHaveAttribute('aria-checked', 'true')
  await expect(drawer(page).getByText('Stop after the first provider')).toBeVisible()
  const sent = await runAll(page, sheetId)
  expect(sent.choices).toMatchObject({ providerOrder: FIND.providerOrder, skipProviders: FIND.skipProviders })
  expect((await stepOf()).choices).toMatchObject({ providerOrder: FIND.providerOrder, skipProviders: ['oldfinder'] })

  const again = await openProviders(page, /^Providers/, 'Hunter')
  await again.click()
  await choose(drawer(page).getByLabel('Which of its rows'), 'any')
  const before = (await asked(find)).length
  await runAll(page, sheetId)
  const after = (await asked(find)).slice(before)
  expect(after.length).toBeGreaterThanOrEqual(3)
  expect(after).not.toContain('hunter')
  expect((await stepOf()).choices).toMatchObject({ skipProviders: ['oldfinder', 'hunter'] })
  await api.dispose()
})

test('"Change tool" starts the new tool with its own providers, none of the old tool\'s switches', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1600, height: 1000 })
  const api = await authedApi()
  await freshTreg(api)
  const old = { ...FIND, providerOrder: ['prospeo', 'hunter'], skipProviders: ['datagma'], stopAtFirst: true }
  const { sheetId, stepOf } = await seed(page, api, { choices: old })

  // The old tool's list: Datagma off, stop after the first provider on.
  const datagma = await openProviders(page, /^Providers/, 'Datagma')
  await expect(datagma).toHaveAttribute('aria-checked', 'false')
  await expect(drawer(page).getByLabel(/Stop after the first provider/)).toBeChecked()

  // Another tool that Datagma also serves from a name and a domain: Datagma on, and no stop after the first.
  await drawer(page).getByRole('button', { name: 'Change tool' }).click()
  await drawer(page).getByLabel('Search tools').fill('person profile')
  await drawer(page).getByTestId('waterfall-tool-search')
    .getByRole('button', { name: /^Person from LinkedIn or email/ }).click()
  await drawer(page).getByRole('button', { name: /^Providers/ }).click()
  const list = drawer(page).getByTestId('waterfall-providers')
  await expect(list.getByRole('switch', { name: 'Use Datagma' })).toHaveAttribute('aria-checked', 'true')
  await expect(drawer(page).getByLabel(/Stop after the first provider/)).not.toBeChecked()
  await list.getByRole('switch', { name: 'Use Datagma' }).scrollIntoViewIfNeeded()
  await shot(page, 'waterfall-change-tool-providers')

  // It answers no email, so it gets an answer field; the run sends, and the step stores, no provider list.
  const { tool } = await (await api.get('/api/enrich/tools/treg.people.enrich')).json()
  await choose(drawer(page).getByLabel('Answer field'), tool.outputs[0].path)
  const sent = await runAll(page, sheetId)
  expect(sent.choices).toMatchObject({
    toolId: 'treg.people.enrich', providerOrder: [], skipProviders: [], stopAtFirst: false,
  })
  const stored = (await stepOf()).choices
  expect(stored.toolId).toBe('treg.people.enrich')
  expect([stored.providerOrder ?? [], stored.skipProviders ?? [], stored.stopAtFirst ?? false]).toEqual([[], [], false])
  await api.dispose()
})
