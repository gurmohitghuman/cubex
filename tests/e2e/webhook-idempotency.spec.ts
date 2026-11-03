import { test, expect, request as pwRequest } from '@playwright/test'
import { authedApi, BASE, getSheet, seedSheet } from './helpers'

// Webhook retries and "Add again" (docs/webhooks.md): a sender's retry with the
// same Idempotency-Key adds its row once, the same key with another body is a
// new event, and a malformed key a 400; after a mapping is added, a row's payload
// window adds that delivery again as a new row read with the mappings as they are now.
test('a retried delivery adds its row once; Add again re-reads a delivery with a new mapping', async ({
  page, context,
}) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  const { tableId, sheetId } = await seedSheet(api, 1)
  const created = await api.post(`/api/sheets/${sheetId}/webhook`, { data: { name: 'e2e retries' } })
  expect(created.status()).toBe(201)
  const url: string = (await created.json()).source.url
  expect((await api.post(`/api/sheets/${sheetId}/webhook/mappings`, {
    data: { jsonPath: '$.mail', columnName: 'mail' },
  })).ok()).toBeTruthy()
  const rowsNow = async () => ((await getSheet(api, sheetId)).data.rows as Array<{ data: Record<string, string> }>)

  const anon = await pwRequest.newContext()
  const send = (data: unknown, key?: string) => anon.post(url, {
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, data,
  })
  const body = { mail: 'ana@example.com', email: 'ana@acme.example' }
  expect((await send(body, 'order-1042')).status()).toBe(202)
  expect((await send(body, 'order-1042')).status()).toBe(202)
  expect((await send({ mail: 'bo@example.com' }, 'order-1042')).status()).toBe(202)
  expect((await send(body, 'order 1042')).status()).toBe(400)
  await anon.dispose()
  expect((await rowsNow()).filter(r => r.data.mail === 'ana@example.com')).toHaveLength(1)
  expect((await rowsNow()).filter(r => r.data.mail === 'bo@example.com')).toHaveLength(1)

  // A field mapped after the event came in: Add again reads it.
  expect((await api.post(`/api/sheets/${sheetId}/webhook/mappings`, {
    data: { jsonPath: '$.email', columnName: 'email' },
  })).ok()).toBeTruthy()
  await page.goto(`${BASE}/table/${tableId}`)
  const anaRow = (await rowsNow()).findIndex(r => r.data.mail === 'ana@example.com')
  const marker = page.locator(`.ag-row[row-index="${anaRow}"] .ag-cell`, { hasText: '📥' }).first()
  await expect(marker).toBeVisible({ timeout: 15_000 })
  await marker.click()
  await expect(page.getByRole('heading', { name: 'Webhook payload' })).toBeVisible()
  await expect(page.getByText('"email": "ana@acme.example"')).toBeVisible()
  await page.getByRole('button', { name: 'Add again' }).click()
  await expect(page.getByText('Added again as a new row, with the mappings as they are now.')).toBeVisible()
  await expect.poll(async () => (await rowsNow()).map(r => `${r.data.mail ?? ''}|${r.data.email ?? ''}`).slice(-2))
    .toEqual(['bo@example.com|', 'ana@example.com|ana@acme.example'])
})
