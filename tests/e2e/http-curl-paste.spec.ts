import { test, expect, Page } from '@playwright/test'
import { authedApi, seedSheet, BASE } from './helpers'
import { JSON_URL } from './api-v1-run-helpers'

// "Paste a cURL command" in the HTTP API column dialog: a command with a key
// asks what to do with it (a masked hint, never the key), saves it as a saved
// key, and fills the form with {{name}} in its place; a command pasted into the
// URL field goes the same way; a refused command says why; and the filled form
// previews for real.

const SECRET = 'sk-proj-e2eSECRET0123456789abcdefgh'
const drawer = (page: Page) => page.locator('[role="dialog"]').filter({ hasText: 'HTTP API Column' })

async function openHttpDrawer(page: Page, tableId: string) {
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'HTTP API', exact: true }).click()
  await expect(drawer(page).getByText('Paste a cURL command')).toBeVisible()
}

async function clearKeys(api: Awaited<ReturnType<typeof authedApi>>, names: string[]) {
  const keys = await (await api.get('/api/settings/api-keys')).json()
  for (const k of keys) if (names.includes(k.name)) await api.delete(`/api/settings/api-keys/${k.id}`)
}

test('a cURL command with a key: saved as a key, the form gets {{name}}, it previews', async ({ page, context }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await clearKeys(api, ['typicode', 'typicode_2'])
  const { tableId } = await seedSheet(api, 2)
  await context.addCookies((await api.storageState()).cookies)
  await openHttpDrawer(page, tableId)
  const d = drawer(page)

  await d.getByTestId('curl-paste-open').click()
  await d.getByTestId('curl-paste-input').fill(
    `curl '${JSON_URL}?fields=title' \\\n  -H 'Authorization: Bearer ${SECRET}' \\\n  -H 'Accept: application/json' \\\n`
    + "  -H 'sec-fetch-mode: cors' --compressed",
  )
  await d.getByTestId('curl-paste-submit').click()

  // The question: where the key is, a masked hint, a suggested name.
  const row = d.getByTestId('curl-key-header:0')
  await expect(row).toContainText('Authorization header')
  await expect(row).toContainText('sk-p…efgh')
  await expect(d).not.toContainText('e2eSECRET')
  await expect(row.getByLabel('New key name', { exact: true })).toHaveValue('typicode')
  await d.getByTestId('curl-keys-confirm').click()

  // Filled: method, URL, a query row, headers with {{typicode}}, the browser header gone.
  await expect(d.getByTestId('curl-paste-notes')).toContainText('sec-fetch-mode')
  await expect(d.locator('input[placeholder="https://api.example.com/data"]')).toHaveValue(JSON_URL)
  await expect(d.locator('input[placeholder="key"]').first()).toHaveValue('fields')
  await expect(d.locator('input[placeholder="Header-Name"]')).toHaveCount(2)
  const values = await d.locator('input[placeholder="Bearer your-token-here"]').inputValue()
  expect(values).toBe('Bearer {{typicode}}')
  await expect(d).not.toContainText('e2eSECRET')
  const keys = await (await api.get('/api/settings/api-keys')).json()
  expect(keys.map((k: { name: string }) => k.name)).toContain('typicode')

  // The filled form works: a preview of the real API.
  await d.getByRole('button', { name: /^Try on/ }).click()
  await expect(page.getByText('delectus aut autem').first()).toBeVisible({ timeout: 30_000 })
  await api.dispose()
})

test('a curl pasted into the URL field, a key already saved, and a refused command', async ({ page, context }) => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await clearKeys(api, ['typicode', 'typicode_2'])
  const made = await api.post('/api/settings/api-keys', {
    data: { name: 'typicode', key_type: 'bearer', key_value: SECRET },
  })
  expect(made.ok()).toBeTruthy()
  const { tableId } = await seedSheet(api, 1)
  await context.addCookies((await api.storageState()).cookies)
  await openHttpDrawer(page, tableId)
  const d = drawer(page)

  // Pasting into the URL field opens the paste box with the command.
  const url = d.locator('input[placeholder="https://api.example.com/data"]')
  await url.focus()
  await url.evaluate((el, text) => {
    const data = new DataTransfer()
    data.setData('text', text)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, `$ curl -X POST ${JSON_URL.replace('/todos/1', '/todos')} -H 'X-API-Key: ${SECRET}' -d 'title=hi&userId=1'`)
  await expect(d.getByTestId('curl-keys-panel')).toBeVisible()
  const row = d.getByTestId('curl-key-header:0')
  await expect(row).toContainText('Already saved as typicode')
  await expect(row.getByLabel('Saved key', { exact: true })).toHaveValue('typicode')
  await d.getByTestId('curl-keys-confirm').click()
  await expect(d.locator('select').filter({ has: page.locator('option[value="DELETE"]') })).toHaveValue('POST')
  await expect(d.locator('input[placeholder="Header-Name"]').nth(0)).toHaveValue('X-API-Key')
  await expect(d.getByText('Request Body', { exact: true })).toBeVisible()
  await expect(d.locator('textarea[placeholder^=\'{"key"\']')).toHaveValue('title=hi&userId=1')
  const keys = await (await api.get('/api/settings/api-keys')).json()
  expect(keys.filter((k: { name: string }) => k.name.startsWith('typicode'))).toHaveLength(1)

  // A command Cubex can't send: the reason, in place.
  await d.getByTestId('curl-paste-open').click()
  await d.getByTestId('curl-paste-input').fill(`curl -F 'file=@photo.png' ${JSON_URL}`)
  await d.getByTestId('curl-paste-submit').click()
  await expect(d.getByTestId('curl-paste-error')).toContainText("Forms and file uploads (-F) aren't supported")
  await api.dispose()
})
