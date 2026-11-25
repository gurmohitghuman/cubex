import { test, expect } from '@playwright/test'
import { authedApi, BASE } from './helpers'
import { freshTreg } from './helpers-enrich'
import { column } from './helpers-setups'

// A social research table in the app (components/social/): the dashboard's dialog offers the platforms treg serves
// with what a search costs and each step's most a post, makes the table (nothing searched), which opens on what
// finding the posts costs; Find posts adds each platform's posts, and the guide above every sheet of the table
// leads to its other sheets and finds posts again.
test('Research social posts: the dialog, the table opens on the estimate, posts found, the guide', async ({
  page, context,
}) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  for (const t of await (await api.get('/api/tables')).json()) await api.delete(`/api/tables/${t.id}`)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/`)
  await page.getByTestId('social-open').click()
  const dialog = page.getByTestId('social-dialog')
  await expect(dialog.getByRole('checkbox', { name: 'TikTok' })).toBeVisible({ timeout: 15_000 })
  await expect(dialog).toContainText('a search')
  const make = dialog.getByTestId('social-create')
  await expect(make).toBeDisabled()
  await dialog.getByLabel('Topic').fill('morning routine')
  await expect(dialog).toContainText('Tick at least one platform.')
  await dialog.getByRole('checkbox', { name: 'TikTok' }).check()
  await dialog.getByRole('checkbox', { name: 'Transcript' }).check()
  await expect(dialog).toContainText(/Transcript · up to \$[\d.]+ a post/)
  await make.click()

  const confirm = page.getByTestId('social-find-confirm')
  await expect(confirm).toContainText('Searches 1 search on TikTok, adding up to 30 posts', { timeout: 30_000 })
  await expect(confirm.getByTestId('social-find-cost')).toContainText('never more')
  await confirm.getByTestId('social-find-go').click()
  await expect(confirm).toBeHidden()

  const banner = page.getByTestId('social-banner')
  await expect(banner).toContainText('Social research: morning routine')
  await expect(banner).toContainText('Top posts: posted in the last 30 days')
  await expect(banner.getByTestId('social-next')).toContainText('open a step\'s column menu')
  const sheetId = new URL(page.url()).pathname.split('/').pop()!
  await expect.poll(() => column(api, sheetId, 'Author'), { timeout: 30_000 })
    .toEqual(['sunny_side_studio', 'mila_mornings', 'calm_kettle'])
  // The guide on Searches too, and Find posts opens the estimate again.
  await banner.getByRole('button', { name: 'Searches' }).click()
  await expect(page.locator('.ag-cell').filter({ hasText: 'morning routine' }).first()).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('social-find').click()
  await expect(page.getByTestId('social-find-confirm')).toContainText('Find posts')
  await api.dispose()
})
