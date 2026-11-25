import { test, expect, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test'
import { authedApi, seedSheet, BASE } from './helpers'
import { openDataMenu } from './helpers-ui'

// The Webhook drawer's Token section (client/src/components/webhook/WebhookToken.tsx): Require a token, after a
// confirm, shows the token once, and the curl example sends the header; events without it get 404, with it 202;
// the page loaded again says one is needed but never shows it; New token (confirmed) stops the old one; Remove
// token (confirmed) lets events in without one. Events go to the real public endpoint.

let sender: APIRequestContext
test.beforeAll(async () => { sender = await pwRequest.newContext({ baseURL: BASE }) })
test.afterAll(async () => { await sender?.dispose() })

const send = async (url: string, token?: string) => (await sender.post(url, {
  data: { email: 'ana@example.com' }, headers: token ? { Authorization: `Bearer ${token}` } : {},
})).status()
const section = (page: Page) => page.getByTestId('webhook-token')
const confirmIn = (page: Page, title: string) => page.getByRole('dialog').filter({ hasText: title })

test('Webhook drawer: require a token, shown once; a new one stops the old; remove it', async ({ page, context }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 2)
  const made = await (await api.post(`/api/sheets/${sheetId}/webhook`, { data: {} })).json()
  const url = new URL(made.source.url, BASE).href
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  await openDataMenu(page, 'Webhook')
  await expect(section(page)).toContainText('Optional. With a token, only senders that send it can add rows')
  await section(page).getByRole('button', { name: 'Require a token' }).click()
  // It asks first: senders that don't send the token yet are turned away from then on.
  const asked = confirmIn(page, 'Require a token?')
  await expect(asked).toContainText("Events that don't send the token are turned away from now on")
  // Nothing changes until it is confirmed. (Read, not an event: the first event hides the URL, and with it the
  // curl example checked below.)
  expect((await (await api.get(`/api/sheets/${sheetId}/webhook`)).json()).source.tokenRequired).toBe(false)
  await asked.getByRole('button', { name: 'Require a token' }).click()
  const value = page.getByTestId('webhook-token-value')
  await expect(value).toHaveText(/^[\w-]{43}$/)
  const token = (await value.textContent())!
  await expect(section(page)).toContainText("Copy it now. It isn't shown again.")
  await expect(page.locator('pre').filter({ hasText: 'curl -X POST' })).toContainText(
    "-H 'Authorization: Bearer <your token>'")

  expect(await send(url)).toBe(404)
  expect(await send(url, 'x'.repeat(43))).toBe(404)
  expect(await send(url, token)).toBe(202)

  // The page loaded again: it says a token is needed, and the token isn't anywhere on the page.
  // (A reload, not Escape: Escape doesn't close a menu or drawer in some Mac runs, a watch item on TODO.md.)
  await page.reload()
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await openDataMenu(page, 'Webhook')
  await expect(section(page)).toContainText('Events must send the token.')
  await expect(value).toBeHidden()
  expect(await page.content()).not.toContain(token)

  await section(page).getByRole('button', { name: 'New token' }).click()
  await confirmIn(page, 'Make a new token?').getByRole('button', { name: 'Make new token' }).click()
  await expect(value).toHaveText(/^[\w-]{43}$/)
  const next = (await value.textContent())!
  expect(next).not.toBe(token)
  expect(await send(url, token)).toBe(404)
  expect(await send(url, next)).toBe(202)

  await section(page).getByRole('button', { name: 'Remove token' }).click()
  await confirmIn(page, 'Remove the token?').getByRole('button', { name: 'Remove token' }).click()
  await expect(section(page)).toContainText('Optional.')
  await expect(value).toBeHidden()
  expect(await send(url)).toBe(202)
})
