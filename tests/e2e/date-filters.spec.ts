import { test, expect, request as pwRequest, type Page } from '@playwright/test'
import { authedApi, seedSheet, makeAccessToken, BASE } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'
import { choose } from './helpers-ui'

// Date conditions, nested AND/OR groups and rules turned off: REST rows/query,
// MCP read_rows and check_run_condition ("Only run if" date words), and the
// grid's filter panel (a date rule, a group, the on/off switch, a reload, the
// header showing the rule it holds, Clear all). Dates in the cells are written
// several ways.

const SIGNED = ['2024-01-31', 'Jan 5, 2024', '15.02.2024', '3/1/2024 10:30 PM', 'soon', '']
const PLAN = ['Pro', 'Free', 'Pro', 'Free', 'Team', 'Pro']

const shownVals = async (page: Page) => (await page.locator('.ag-center-cols-container .ag-row').allInnerTexts())
  .map(t => t.split('\n').find(x => /^v\d$/.test(x.trim()))?.trim()).filter(Boolean).sort()
const rules = (page: Page) => page.getByTestId('filter-panel').getByTestId('filter-rule')

test('date filters, nested groups and rules turned off: REST, MCP, rules and the grid', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 6)
  for (const [columnName, values] of [['Signed', SIGNED], ['Plan', PLAN]] as const) {
    await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName } })
    expect((await api.put(`/api/sheets/${sheetId}/data`, { data: {
      updates: values.map((value, rowIndex) => ({ rowIndex, columnName, value })) } })).ok()).toBeTruthy()
  }
  const token = await makeAccessToken(api, ['read'], 'date-filters')
  const client = await mcpClient(token)
  const v1 = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` } })
  const query = async (where: unknown) => {
    const res = await v1.post(`/api/v1/sheets/${sheetId}/rows/query`, { data: { where } })
    const body = await res.json()
    return res.ok() ? body.rows.map((r: { data: { val: string } }) => r.data.val) : `${res.status()} ${body.error}`
  }

  // REST: days compared whatever the format; a cell with no date passes none, "is not" included.
  expect(await query([{ column: 'Signed', operator: 'date_gte', value: '2024-02-01' }])).toEqual(['v2', 'v3'])
  expect(await query([{ column: 'Signed', operator: 'date_lt', value: 'Feb 1, 2024' }])).toEqual(['v0', 'v1'])
  expect(await query([{ column: 'Signed', operator: 'date_eq', value: '1.3.2024' }])).toEqual(['v3'])
  expect(await query([{ column: 'Signed', operator: 'date_neq', value: '2024-01-31' }])).toEqual(['v1', 'v2', 'v3'])
  expect(await query([{ column: 'Signed', operator: 'empty' }])).toEqual(['v5'])
  const nested = [{ or: [{ column: 'Signed', operator: 'date_lt', value: '2024-01-10' },
    { and: [{ column: 'Plan', operator: 'eq', value: 'pro' }, { column: 'Signed', operator: 'date_gt',
      value: '2024-02-01' }] }] }]
  expect(await query(nested)).toEqual(['v1', 'v2'])
  expect(await query([{ column: 'Plan', operator: 'eq', value: 'free', enabled: false }])).toHaveLength(6)
  expect(await query([{ column: 'Plan', operator: 'eq', value: 'pro' },
    { or: [{ column: 'Signed', operator: 'empty', enabled: false }] }])).toEqual(['v0', 'v2', 'v5'])
  expect(await query([{ column: 'Signed', operator: 'date_gt', value: 'soon' }]))
    .toContain('400 date_gt requires a date')
  const deep = (n: number): unknown => (n === 0 ? { column: 'Plan', operator: 'empty' } : { and: [deep(n - 1)] })
  expect(await query([deep(6)])).toContain('at most 5 deep')

  // MCP: the same nested where, and a bad group refused with the grammar's message.
  const read = await call(client, 'read_rows', { sheet_id: sheetId, where: nested, columns: ['val'] })
  expect(read.rows.map((r: { data: { val: string } }) => r.data.val)).toEqual(['v1', 'v2'])
  expect(await callError(client, 'read_rows', { sheet_id: sheetId,
    where: [{ or: [{ column: 'Plan', operator: 'eq', value: 'x', op: 'eq' }] }] })).toContain('Unknown key "op"')
  expect(await callError(client, 'read_rows', { sheet_id: sheetId,
    where: [{ column: 'Signed', operator: 'date_lte', value: 'later' }] })).toContain('requires a date')

  // "Only run if": the same days, in words.
  const rule = await call(client, 'check_run_condition', { sheet_id: sheetId,
    rule: '{{Signed}} is on or after 2024-02-01 AND {{Plan}} is "pro"' })
  expect([rule.rule, rule.rows_passing]).toEqual(['{{Signed}} is on or after "2024-02-01" AND {{Plan}} is "pro"', 1])
  expect(await callError(client, 'check_run_condition', { sheet_id: sheetId, rule: '{{Signed}} is before "soon"' }))
    .toContain(`"soon" isn't a date`)

  // The grid's filter panel.
  await page.setViewportSize({ width: 1280, height: 800 })
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect.poll(() => shownVals(page), { timeout: 15_000 }).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5'])
  await page.getByTestId('filter-button').click()
  const panel = page.getByTestId('filter-panel')
  await panel.getByRole('button', { name: 'Add rule' }).first().click()
  await choose(rules(page).nth(0).getByLabel('Column'), 'Signed')
  await choose(rules(page).nth(0).getByLabel('Condition'), 'date_gte')
  await rules(page).nth(0).getByLabel('Date').fill('2024-02-01')
  await rules(page).nth(0).getByLabel('Date').press('Enter')
  await expect.poll(() => shownVals(page)).toEqual(['v2', 'v3'])

  // A group: any of Plan is free, Plan is pro.
  await panel.getByRole('button', { name: 'Add group' }).first().click()
  const group = panel.getByTestId('filter-group')
  await expect(group).toContainText('Any of these')
  for (const [i, value] of [[0, 'free'], [1, 'pro']] as const) {
    if (i === 1) await group.getByRole('button', { name: 'Add rule' }).click()
    const rule = group.getByTestId('filter-rule').nth(i)
    await choose(rule.getByLabel('Column'), 'Plan')
    await choose(rule.getByLabel('Condition'), 'eq')
    await rule.getByLabel('Value').fill(value)
    await rule.getByLabel('Value').press('Enter')
  }
  await expect.poll(() => shownVals(page)).toEqual(['v2', 'v3'])
  await group.getByTestId('filter-rule').nth(1).getByRole('switch').click()
  await expect.poll(() => shownVals(page)).toEqual(['v3'])
  await group.getByTestId('filter-rule').nth(1).getByRole('switch').click()
  await expect.poll(() => shownVals(page)).toEqual(['v2', 'v3'])
  await page.screenshot({ path: test.info().outputPath('filter-panel-1280.png') })

  // The date rule off: the group alone.
  await rules(page).nth(0).getByRole('switch').click()
  await expect.poll(() => shownVals(page)).toEqual(['v0', 'v1', 'v2', 'v3', 'v5'])
  const saved = (await (await api.get(`/api/sheets/${sheetId}?limit=1`)).json()).sheet
  expect(JSON.parse(saved.row_filter)).toEqual([
    { column: 'Signed', operator: 'date_gte', value: '2024-02-01', enabled: false },
    { or: [{ column: 'Plan', operator: 'eq', value: 'free' }, { column: 'Plan', operator: 'eq', value: 'pro' }] },
  ])
  expect(saved.column_filters).toBeNull()

  // After a reload the panel opens on the saved filter; turned back on, the
  // date rule is the Signed header's filter.
  await page.reload()
  await expect(page.getByTestId('filter-button')).toContainText('"Plan" is "free" or "Plan" is "pro"')
  await page.getByTestId('filter-button').click()
  await expect(rules(page).nth(0).getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  await rules(page).nth(0).getByRole('switch').click()
  await expect.poll(() => shownVals(page)).toEqual(['v2', 'v3'])
  await expect.poll(async () => (await (await api.get(`/api/sheets/${sheetId}?limit=1`)).json()).sheet.column_filters)
    .toBe(JSON.stringify({ Signed: { type: 'date_gte', value: '2024-02-01' } }))
  await page.keyboard.press('Escape')
  await page.locator('.ag-header-cell').filter({ hasText: 'Signed' }).first().locator('.ag-header-cell-text').click()
  await expect(page.getByLabel('Filter condition')).toHaveAttribute('data-value', 'date_gte')
  await expect(page.getByLabel('Date')).toHaveValue('2024-02-01')
  await page.keyboard.press('Escape')

  // A text rule switched to "is any of" keeps its value; a value ticked in the
  // list applies at once, no Done needed.
  await page.getByTestId('filter-button').click()
  await panel.getByRole('button', { name: 'Add rule' }).last().click()
  const plan = rules(page).last()
  await choose(plan.getByLabel('Column'), 'Plan')
  await plan.getByLabel('Value').fill('pro')
  await plan.getByLabel('Value').press('Enter')
  await expect.poll(() => shownVals(page)).toEqual(['v2'])
  await choose(plan.getByLabel('Condition'), 'any_of')
  await expect(plan.getByRole('button', { name: 'pro' })).toBeVisible()
  await plan.getByRole('button', { name: 'pro' }).click()
  await plan.getByRole('checkbox').nth(0).waitFor()
  await plan.getByText('Free', { exact: true }).click()
  await expect.poll(() => shownVals(page)).toEqual(['v2', 'v3'])
  await page.keyboard.press('Escape')
  // Plan's first top-level rule that is on, so its header holds it.
  const kept = JSON.parse((await (await api.get(`/api/sheets/${sheetId}?limit=1`)).json()).sheet.column_filters)
  expect(kept.Plan).toEqual({ type: 'any_of', values: ['pro', 'Free'] })

  await page.getByLabel('Clear all filters').click()
  await expect.poll(() => shownVals(page)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5'])
  await expect(page.getByTestId('filter-button')).toHaveText('Filter')
})
