// Over 200 lines: one feature through the app, REST and MCP, its cases run in order on one account.
import { test, expect, APIRequestContext } from '@playwright/test'
import os from 'node:os'
import { authedApi, BASE, getSheet, importCsv, seedSheet } from './helpers'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'
import { call, callError, mcpClient } from './helpers-mcp'
import { Receiver } from './helpers-receiver'

// A deleted column goes to the trash (migration 054). In the app: deleted from its header menu (the confirm and the
// toast say it goes to the trash), it shows on the Trash page as a column with its cells inside, and Restore puts
// it back at its place with its cells; a delete that answers "moving" offers no Restore in its toast and says to
// restore it from the Trash once its cells are in. Over REST: an HTTP API column's delete answers where it went,
// list and look inside find it, restore brings it back set up as it was, and its rerun fills it again through the
// receiver; refusals answer their status and words. Over MCP: delete_column, list_trash and restore_from_trash, the
// answer's references_dropped, and a refusal as an isError result.
const SHOT_DIR = process.env.SHOT_DIR || os.tmpdir()
const HEADER = (name: string) => `.ag-header-cell[col-id^="col_"]:has-text("${name}")`
const rx = new Receiver()
let api: APIRequestContext

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => { await rx.start(); api = await authedApi() })
test.afterAll(async () => { await rx.stop() })

const csvSheet = async (csv: string) => {
  const { tableId, sheetId } = await seedSheet(api, 1)
  expect((await importCsv(api, sheetId, csv, { replaceData: true })).ok()).toBeTruthy()
  return { tableId, sheetId }
}
// The grid's column names as they show, left to right.
const shownColumns = (page: import('@playwright/test').Page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('.ag-header-cell[col-id^="col_"]'))
    .map(h => ({ x: h.getBoundingClientRect().left, name: (h.querySelector('.ag-header-cell-text')?.textContent ?? '')
      .trim() }))
    .sort((a, b) => a.x - b.x).map(h => h.name))
const columnsOf = async (sheetId: string) => (await getSheet(api, sheetId)).data.columns as string[]
const notesOf = async (sheetId: string) => ((await getSheet(api, sheetId)).data.rows as
  Array<{ data: Record<string, string> }>).map(r => r.data.Notes ?? '')

test('app: delete a column from its menu, find it in the Trash page, restore it with its cells', async ({ page,
  context }) => {
  test.setTimeout(120_000)
  await context.addCookies((await api.storageState()).cookies)
  const { tableId, sheetId } =
    await csvSheet('Name,Notes,City\nAnn,called twice,Oslo\nBo,,Rome\nCy,wants a demo,Lima\n')
  expect(await columnsOf(sheetId)).toEqual(['Name', 'Notes', 'City'])

  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator(HEADER('Notes'))).toBeVisible({ timeout: 15_000 })
  await page.locator(HEADER('Notes')).click({ button: 'right' })
  await page.getByText('Delete column', { exact: true }).click()
  await expect(page.getByText(/It goes to the trash with its cells, its description and its setup, where you can /))
    .toBeVisible()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  const toast = page.getByTestId('deleted-toast')
  await expect(toast).toContainText('Column "Notes" moved to the trash')
  await expect(page.locator(HEADER('Notes'))).toHaveCount(0)
  await expect.poll(() => columnsOf(sheetId)).toEqual(['Name', 'City'])
  await page.screenshot({ path: `${SHOT_DIR}/column-trash-01-toast.png` })

  // The account's trash holds what other specs deleted too: this column's item by its id.
  const trashed = await (await api.get('/api/trash', { params: { kind: 'column', sheet_id: sheetId } })).json()
  expect(trashed.items).toHaveLength(1)
  await page.goto(`${BASE}/trash`)
  const entry = page.locator(`[data-trash-id="${trashed.items[0].id}"]`)
  await expect(entry).toContainText('Column "Notes" from "Sheet1"')
  await expect(entry).toContainText('2 cells · a plain column')
  await expect(entry).toContainText('Column deleted by')
  await entry.getByTestId('trash-more').click()
  await page.getByTestId('trash-look').click()
  const inside = page.getByTestId('trash-rows').locator('tbody tr')
  await expect(inside).toHaveCount(2)
  await expect(inside.nth(0)).toContainText('called twice')
  await expect(inside.nth(1)).toContainText('wants a demo')
  await expect(page.getByTestId('trash-rows-restore')).toHaveCount(0)
  await page.screenshot({ path: `${SHOT_DIR}/column-trash-02-inside.png` })
  await page.mouse.click(40, 400)   // outside the drawer closes it
  await expect(page.getByTestId('trash-rows')).toBeHidden()
  await entry.getByTestId('trash-restore').click()
  await expect(page.getByText('Restored the column "Notes", 2 cells back.')).toBeVisible({ timeout: 10_000 })
  await expect(entry).toHaveCount(0)

  expect(await columnsOf(sheetId)).toEqual(['Name', 'Notes', 'City'])
  expect(await notesOf(sheetId)).toEqual(['called twice', '', 'wants a demo'])
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator(HEADER('City'))).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => shownColumns(page)).toEqual(['Name', 'Notes', 'City'])
  await page.screenshot({ path: `${SHOT_DIR}/column-trash-03-back.png` })

  // The toast's Restore does the same.
  await page.locator(HEADER('Notes')).click({ button: 'right' })
  await page.getByText('Delete column', { exact: true }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByTestId('deleted-toast-restore').click()
  await expect(page.getByText('Restored the column "Notes", 2 cells back.')).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => shownColumns(page), { timeout: 15_000 }).toEqual(['Name', 'Notes', 'City'])
  expect(await notesOf(sheetId)).toEqual(['called twice', '', 'wants a demo'])
})

// A big column's delete answers before its cells are all in (`trash.moving`, unit-tested at this route in
// column-trash-moving): its answer here is marked so, the real delete going through underneath.
test('app: a delete that answers "moving" says where to restore it from, with no Restore in its toast', async ({
  page, context }) => {
  test.setTimeout(60_000)
  await context.addCookies((await api.storageState()).cookies)
  const { tableId, sheetId } = await csvSheet('Name,Notes\nAnn,called twice\nBo,later\n')
  await page.route(`**/api/sheets/${sheetId}/columns/Notes`, async route => {
    if (route.request().method() !== 'DELETE') return route.continue()
    const real = await route.fetch()
    const body = await real.json()
    expect(body.trash).toEqual({ id: expect.any(Number), days: expect.any(Number) })
    await route.fulfill({ response: real, json: { ...body, trash: { ...body.trash, moving: true } } })
  })
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator(HEADER('Notes'))).toBeVisible({ timeout: 15_000 })
  await page.locator(HEADER('Notes')).click({ button: 'right' })
  await page.getByText('Delete column', { exact: true }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('Column "Notes" deleted: its cells are still going to the trash. You can restore it '
    + 'from the Trash once they are in.')).toBeVisible()
  await expect(page.getByTestId('deleted-toast-restore')).toHaveCount(0)
  await expect(page.getByTestId('deleted-toast')).toHaveCount(0)
  await expect(page.locator(HEADER('Notes'))).toHaveCount(0)
  expect(await columnsOf(sheetId)).toEqual(['Name'])
  await expect(page.getByText(/It goes to the trash with its cells/)).toBeHidden()
  await page.screenshot({ path: `${SHOT_DIR}/column-trash-04-moving-toast.png` })
})

test('REST: an HTTP API column goes to the trash, comes back set up, and its rerun fills it again', async () => {
  rx.on('/title', { status: 200, body: '{"title":"CEO"}' }, { status: 200, body: '{"title":"CEO"}' },
    { status: 200, body: '{"title":"CTO"}' }, { status: 200, body: '{"title":"CTO"}' })
  const v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e column trash'))
  const { sheetId } = await csvSheet('Name\nAnn\nBo\n')
  const start = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, { data: {
    url: rx.url('/title'), method: 'POST', body: '{"n": "{{Name}}"}', master_column_name: 'Call',
    response_mapping: [{ json_path: '$.title', column_name: 'Title' }] } })
  expect(start.status(), await start.text()).toBe(202)
  expect((await waitForTerminal(v1, `/api/v1/http-runs/${(await start.json()).run_id}`)).status).toBe('completed')

  const del = await v1.delete(`/api/v1/sheets/${sheetId}/columns/Call`)
  expect(del.status(), await del.text()).toBe(200)
  const out = await del.json()
  expect(out).toMatchObject({ deleted: true, trash: { kept_days: 30, state: 'kept',
    how_to_restore: `POST /api/v1/trash/${out.trash.trash_id}/restore puts it back (GET /api/v1/trash lists the `
      + 'trash).' } })
  const id = out.trash.trash_id as number
  const list = await (await v1.get('/api/v1/trash', { params: { kind: 'column', q: 'Call' } })).json()
  expect(list.items.find((i: { id: number }) => i.id === id)).toMatchObject({ kind: 'column', how: 'column',
    column: 'Call', cells: 2, column_kind: 'an HTTP API column', columns: ['Call'], token_name: 'e2e column trash' })
  const inside = await (await v1.get(`/api/v1/trash/${id}/rows`)).json()
  expect(inside.rows.map((r: { cells: Record<string, string> }) => r.cells)).toEqual([{ Call: '✅ Success' },
    { Call: '✅ Success' }])

  const seqs = await v1.post(`/api/v1/trash/${id}/restore`, { data: { seqs: [1] } })
  expect(seqs.status()).toBe(400)
  expect(await seqs.json()).toEqual({ error: 'A column comes back whole: restore it without seqs.' })
  const back = await v1.post(`/api/v1/trash/${id}/restore`)
  expect(back.status(), await back.text()).toBe(200)
  const got = await back.json()
  expect(got).toMatchObject({ kind: 'column', name: 'Call', renamed: false, position: 1, cells_restored: 2,
    setup: { kind: 'http', restored: true } })
  expect(got.setup.note).toContain(`POST /api/v1/http-runs/${got.setup.run_id}/rerun`)

  const rerun = await v1.post(`/api/v1/http-runs/${got.setup.run_id}/rerun`, { data: { mode: 'all' } })
  expect(rerun.status(), await rerun.text()).toBe(202)
  expect((await waitForTerminal(v1, `/api/v1/http-runs/${(await rerun.json()).run_id}`)).status).toBe('completed')
  // Two requests for the first run, two more for the rerun of the restored column.
  expect(rx.hitsOn('/title').map(h => JSON.parse(h.body).n).sort()).toEqual(['Ann', 'Ann', 'Bo', 'Bo'])
  const rows = (await (await v1.get(`/api/v1/sheets/${sheetId}/rows`)).json()).rows as Array<{ data: any }>
  expect(rows.map(r => r.data)).toEqual([{ Name: 'Ann', Call: '✅ Success', Title: 'CTO' },
    { Name: 'Bo', Call: '✅ Success', Title: 'CTO' }])

  // A column whose sheet is in the trash waits for it.
  const again = (await (await v1.delete(`/api/v1/sheets/${sheetId}/columns/Title`)).json()).trash.trash_id
  const table = (await (await api.get('/api/tables')).json())[0]
  const extra = await (await api.post(`/api/tables/${table.id}/sheets`, { data: { name: 'Other' } })).json()
  expect(extra.sheet?.id).toBeTruthy()
  expect((await api.delete(`/api/tables/${table.id}/sheets/${sheetId}`)).ok()).toBeTruthy()
  const waits = await v1.post(`/api/v1/trash/${again}/restore`)
  expect(waits.status()).toBe(409)
  expect((await waits.json()).error).toBe('Its sheet "Sheet1" is in the trash. Restore the sheet first.')
  await v1.dispose()
})

test('MCP: delete_column, list_trash and restore_from_trash, with what did not come back', async () => {
  const client = await mcpClient(await makeToken(api, ['read', 'write'], 'e2e column trash mcp'))
  const { sheetId } = await csvSheet('Email,Name\nann@acme.com,Ann\nbo@beta.io,Bo\n')
  await call(client, 'manage_view', { sheet_id: sheetId, action: 'create', name: 'Slim', hidden_columns: ['Email'] })
  await call(client, 'set_auto_dedupe', { sheet_id: sheetId, column: 'Email' })
  const out = await call(client, 'delete_column', { sheet_id: sheetId, column: 'Email' })
  expect(out.deleted).toBe(true)
  const id = out.trash.trash_id as number
  expect(out.trash.how_to_restore).toBe(`restore_from_trash with trash_ids [${id}] puts it back (list_trash shows `
    + 'what is in the trash).')
  const listed = await call(client, 'list_trash', { kind: 'column', sheet_id: sheetId })
  expect(listed.items.map((i: { id: number }) => i.id)).toEqual([id])
  expect(listed.items[0]).toMatchObject({ column: 'Email', cells: 2, references_dropped: 2 })
  const one = await call(client, 'list_trash', { trash_id: id, contains: 'beta' })
  expect(one.rows.map((r: { cells: unknown }) => r.cells)).toEqual([{ Email: 'bo@beta.io' }])
  expect(await callError(client, 'restore_from_trash', { trash_id: id, seqs: [1] }))
    .toBe('A column comes back whole: restore it without seqs.')
  await call(client, 'add_column', { sheet_id: sheetId, name: 'email' })
  const { results } = await call(client, 'restore_from_trash', { trash_ids: [id] })
  expect(results[0].restored).toMatchObject({ name: 'Email (restored)', renamed: true, position: 0,
    cells_restored: 2 })
  expect(results[0].restored.references_dropped.map((r: { where: string; redo: string }) => [r.where, r.redo]))
    .toEqual([['view "Slim"', 'manage_view with action "change", view "Slim" and "Email (restored)" in hidden_columns'],
      ['auto-dedupe', 'set_auto_dedupe with column "Email (restored)"']])
  const history = await call(client, 'get_sheet_history', { sheet_id: sheetId, column: 'Email (restored)' })
  expect(history.changes[0].summary).toBe('Restored the column "Email" as "Email (restored)" from the trash (2 cells '
    + 'back)')
  await client.close()
})
