import { test, expect, type Page } from '@playwright/test'
import { authedApi, seedSheet, getSheet, makeAccessToken, BASE } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'

// get_sheet's column details and descriptions, over MCP, REST and in the app:
// each column's kind, what fills it and what it reads, counts on request; a
// column's and a sheet's description set, carried by a rename, read back; a
// description set over REST reaching an open grid; the column menu's and the
// tab menu's Edit description. SHOTS=<dir> saves screenshots.
const SHOTS = process.env.SHOTS
// After the dialog's fade-in (200 ms) and the menu's fade-out.
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

test('MCP: column_details, counts and descriptions', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write'], 'e2e details rw'))
  await call(client, 'clean_column', { sheet_id: sheetId, source_column: 'val', cleaner: 'title_case' })
  await call(client, 'formula_column', { sheet_id: sheetId, column: 'Upper', formula: '{{val}}.toUpperCase()' })
  await expect.poll(async () => (await call(client, 'get_sheet', { sheet_id: sheetId })).filling_columns,
    { timeout: 15_000 }).toEqual([])

  expect(await call(client, 'set_description', { sheet_id: sheetId, column: 'val', description: '  The value \n' }))
    .toEqual({ column: 'val', description: 'The value' })
  expect(await call(client, 'set_description', { sheet_id: sheetId, description: 'Seeded rows' }))
    .toEqual({ description: 'Seeded rows' })

  const meta = await call(client, 'get_sheet', { sheet_id: sheetId, include_counts: true })
  expect(meta.description).toBe('Seeded rows')
  const by = Object.fromEntries(meta.column_details.map((d: any) => [d.name, d]))
  expect(by.val).toEqual({ name: 'val', kind: 'plain', description: 'The value',
    counts: { filled: 3, empty: 0, errors: 0 } })
  expect(by['val (clean)']).toMatchObject({ kind: 'clean', reads: ['val'], auto_run: true,
    fill: { cleaner: 'title_case', fill_status: 'done' }, counts: { filled: 3, empty: 0, errors: 0 } })
  expect(by.Upper).toMatchObject({ kind: 'formula', reads: ['val'], fill: { formula: '{{val}}.toUpperCase()' } })

  // A rename carries the description; a delete takes it.
  await call(client, 'rename_column', { sheet_id: sheetId, column: 'val', new_name: 'Value' })
  const renamed = await call(client, 'get_sheet', { sheet_id: sheetId, columns: ['Value'] })
  expect(renamed.column_details.find((d: any) => d.name === 'Value').description).toBe('The value')
  expect(await callError(client, 'get_sheet', { sheet_id: sheetId, columns: ['Nope'] })).toContain('"Nope"')
  expect(await callError(client, 'set_description', { sheet_id: sheetId, column: 'Nope', description: 'x' }))
    .toContain('not found')
  const added = await call(client, 'add_column', { sheet_id: sheetId, name: 'Notes', description: 'Free text' })
  expect(added).toEqual({ name: 'Notes', description: 'Free text' })
  await client.close()

  // A read token reads them and can't write them.
  const reader = await mcpClient(await makeAccessToken(api, ['read'], 'e2e details read'))
  expect((await call(reader, 'get_sheet', { sheet_id: sheetId })).description).toBe('Seeded rows')
  expect(await callError(reader, 'set_description', { sheet_id: sheetId, description: 'x' })).toContain('write')
  await reader.close()
})

test('REST: GET /sheets/:id details and counts; PATCH and POST take descriptions', async () => {
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 2)
  const token = await makeAccessToken(api, ['read', 'write'], 'e2e details rest')
  const headers = { Authorization: `Bearer ${token}` }
  const v1 = `${BASE}/api/v1`

  const described = await api.patch(`${v1}/sheets/${sheetId}/columns/val`, { headers, data: { description: 'Seed' } })
  expect(await described.json()).toEqual({ name: 'val', description: 'Seed' })
  const sheetPatch = await api.patch(`${v1}/tables/${tableId}/sheets/${sheetId}`,
    { headers, data: { description: 'Two rows' } })
  expect((await sheetPatch.json()).sheet.description).toBe('Two rows')
  const post = await api.post(`${v1}/sheets/${sheetId}/columns`, { headers, data: { name: 'B', description: 'Bee' } })
  expect(post.status()).toBe(201)
  expect(await post.json()).toEqual({ name: 'B', description: 'Bee' })

  const meta = await (await api.get(`${v1}/sheets/${sheetId}?include_counts=true&columns=val`, { headers })).json()
  expect(meta.description).toBe('Two rows')
  expect(meta.column_details).toEqual([
    { name: 'val', kind: 'plain', description: 'Seed', counts: { filled: 2, empty: 0, errors: 0 } },
    { name: 'B', kind: 'plain', description: 'Bee' },
  ])
  expect((await api.get(`${v1}/sheets/${sheetId}?include_counts=maybe`, { headers })).status()).toBe(400)

  // A description that is too long changes nothing, the rename that came with it included.
  const tooLong = await api.patch(`${v1}/sheets/${sheetId}/columns/B`,
    { headers, data: { name: 'C', description: 'x'.repeat(1001) } })
  expect(tooLong.status()).toBe(400)
  expect((await getSheet(api, sheetId)).data.columns).toEqual(['val', 'B'])
  // Rename and describe in one call; "" clears.
  const both = await api.patch(`${v1}/sheets/${sheetId}/columns/B`, { headers, data: { name: 'C', description: '' } })
  expect(await both.json()).toEqual({ name: 'C', description: null })
})

test('App: Edit description from the column menu and the tab menu; one set over REST shows up', async ({
  page, context,
}) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 3)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  const header = page.locator('.ag-header-cell').filter({ hasText: 'val' }).first()
  await header.locator('.ag-header-cell-text').first().click()
  await page.getByTestId('edit-description').click()
  const dialog = page.getByTestId('description-dialog')
  await expect(dialog).toContainText('Column description: val')
  await page.getByTestId('description-text').fill('The seeded value.\nOne per row.')
  await shot(page, 'description-1-column-dialog')
  await page.getByTestId('description-save').click()
  await expect(dialog).toBeHidden()
  await page.getByTestId('description-icon').hover()
  await expect(page.getByTestId('header-tip')).toContainText('The seeded value.')
  await shot(page, 'description-2-header-tip')
  expect((await getSheet(api, sheetId)).data.columnDescriptions).toEqual({ val: 'The seeded value.\nOne per row.' })

  // The sheet's, from its tab menu.
  const sheetName = (await getSheet(api, sheetId)).sheet.name
  await page.getByRole('button', { name: `Sheet options for ${sheetName}` }).click()
  await page.getByTestId('describe-sheet').click()
  await page.getByTestId('description-text').fill('Test rows for descriptions')
  await shot(page, 'description-3-sheet-dialog')
  await page.getByTestId('description-save').click()
  await expect(page.getByRole('button', { name: sheetName, exact: true })).toHaveAttribute('title',
    'Test rows for descriptions')

  // Removed from the dialog: the icon goes.
  await header.locator('.ag-header-cell-text').first().click()
  await page.getByTestId('edit-description').click()
  await page.getByTestId('description-remove').click()
  await expect(page.getByTestId('description-icon')).toHaveCount(0)

  // Set over REST (an agent): the open grid picks it up without a reload.
  const token = await makeAccessToken(api, ['read', 'write'], 'e2e details live')
  await api.patch(`${BASE}/api/v1/sheets/${sheetId}/columns/val`,
    { headers: { Authorization: `Bearer ${token}` }, data: { description: 'Set by an agent' } })
  await expect(page.getByTestId('description-icon')).toHaveCount(1, { timeout: 30_000 })
  await page.getByTestId('description-icon').hover()
  await expect(page.getByTestId('header-tip')).toContainText('Set by an agent')
  await shot(page, 'description-4-live')
})
