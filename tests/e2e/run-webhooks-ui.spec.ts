import { test, expect, Page } from '@playwright/test'
import { authedApi, BASE } from './helpers'
import { Receiver } from './helpers-receiver'

// Settings, Run webhooks in the app: add one, its secret shown once, a test
// notice delivered to a local receiver (tests/e2e/net-shim.cjs) and the log; a
// private URL refused. Screenshots land in test-results/shots/.
const rx = new Receiver()
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `test-results/shots/${name}.png`, fullPage: true })

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await rx.start()
  rx.on('/ui-hook', { status: 200 })
})
test.afterAll(async () => { await rx.stop() })

test('Settings, Run webhooks: add one, its secret shown once, a test, the log', async ({ page, context }) => {
  const api = await authedApi()
  for (const h of (await (await api.get('/api/settings/run-webhooks')).json()).webhooks) {
    await api.delete(`/api/settings/run-webhooks/${h.id}`)
  }
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/settings/run-webhooks`)
  await expect(page.getByRole('heading', { name: 'Run webhooks', exact: true })).toBeVisible()
  await expect(page.getByText('No run webhooks yet')).toBeVisible()

  await page.getByTestId('run-webhook-add').click()
  await page.getByTestId('run-webhook-url').fill(rx.url('/ui-hook', 'ui'))
  await page.getByTestId('run-webhook-create').click()
  const secret = page.getByTestId('run-webhook-secret')
  await expect(secret).toHaveText(/^cubex_whsig_/)
  await shot(page, 'run-webhooks-secret-once')
  await page.getByRole('button', { name: 'Done' }).click()

  const card = page.getByTestId('run-webhook-card')
  await expect(card.getByTestId('run-webhook-card-url')).toHaveText(rx.url('/ui-hook', 'ui'))
  await expect(card.getByTestId('run-webhook-card-every')).toBeChecked()
  await expect(page.getByText('cubex_whsig_')).toHaveCount(0)

  await card.getByTestId('run-webhook-test').click()
  await expect(page.getByText('Test delivered: the URL answered 200')).toBeVisible()
  await expect(card.getByTestId('run-webhook-deliveries')).toContainText('Delivered (200)')
  expect(rx.hitsOn('/ui-hook')).toHaveLength(1)
  await shot(page, 'run-webhooks-log')

  // A private URL is refused with the reason.
  await page.getByTestId('run-webhook-add').click()
  await page.getByTestId('run-webhook-url').fill(`http://127.0.0.1:${rx.port}/x`)
  await page.getByTestId('run-webhook-create').click()
  await expect(page.getByText(/only to public addresses/)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
})
