import { test, expect } from '@playwright/test'
import { BASE, authedApi, makeAccessToken } from './helpers'
import { freshTreg, seedLeadRows } from './helpers-enrich'
import { mcpClient, call, waitMcpRun } from './helpers-mcp'

// The sheet's Scheduled reruns drawer (the ⋯ menu): it lists the sheet's run columns to pick from, adds a weekly
// schedule (it shows when it fires next), pauses and resumes it, runs it now (the last firing shows, no error),
// and deletes it. A run now that can't start (its column renamed since) says why instead of "Started". What a run
// now would cost shows before Add schedule (the form's rows: none to run, then the one row) and on the schedule
// before Run now, and the schedule whose column is gone says it wouldn't start before Run now is clicked.
test('scheduled reruns from the sheet menu: add, pause, run now, delete', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  await freshTreg(api)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], `schedules-ui-${Date.now()}`))
  const { tableId, sheetId } = await seedLeadRows(api, [{ Name: 'Maya Chen', Website: 'stripe.com' }])
  const run = await call(client, 'run_enrichment', { sheet_id: sheetId, tool_id: 'treg.people.email.find',
    column_name: 'Work email', inputs: { full_name: 'Name', domain: 'Website' },
    outputs: [{ field: 'email', column_name: 'Email' }] })
  await waitMcpRun(client, run.run_id, ['completed', 'failed'])

  await page.goto(`${BASE}/table/${tableId}`)
  await page.getByTestId('more-menu').click()
  await page.getByTestId('sheet-schedules').click()
  await expect(page.getByTestId('schedules-empty')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('schedule-form')).toContainText('Work email')
  const formCost = page.getByTestId('schedule-form-cost')
  await expect(formCost).toHaveText('A run now would find no rows to run.')

  await page.getByTestId('schedule-cadence').selectOption('weekly')
  await page.getByTestId('schedule-rows').selectOption('all')
  const oneRow = /^A run now would cost (nothing|about .+) for 1 row\.$/
  await expect(formCost).toHaveText(oneRow)
  await page.getByTestId('schedule-add').click()
  const item = page.getByTestId('schedule-item')
  await expect(item).toHaveCount(1)
  await expect(item).toContainText('Every Monday at 09:00')
  await expect(item).toContainText('Every run column')
  await expect(item).toContainText('Last: never')
  await expect(item.getByTestId('schedule-cost')).toHaveText(oneRow)

  await page.getByTestId('schedule-pause').click()
  await expect(item).toContainText('paused')
  await page.getByTestId('schedule-pause').click()
  await expect(item).not.toContainText('· paused')

  await page.getByTestId('schedule-fire').click()
  await expect(item).not.toContainText('Last: never', { timeout: 10_000 })
  await expect(page.getByText('Started', { exact: true })).toBeVisible()
  await expect(page.getByTestId('schedule-error')).toHaveCount(0)

  await page.getByTestId('schedule-delete').click()
  await expect(page.getByTestId('schedules-empty')).toBeVisible()

  await call(client, 'manage_run_schedule', { action: 'create', sheet_id: sheetId, columns: ['Work email'],
    rows: 'errored', cadence: 'daily', at_time: '09:00' })
  await call(client, 'rename_column', { sheet_id: sheetId, column: 'Work email', new_name: 'Found email' })
  await page.keyboard.press('Escape')
  await page.getByTestId('more-menu').click()
  await page.getByTestId('sheet-schedules').click()
  await expect(item).toHaveCount(1)
  await expect(item.getByTestId('schedule-cost')).toContainText(/^A run now wouldn't start: .*Work email/)
  await page.getByTestId('schedule-fire').click()
  await expect(page.getByText(/^It didn't start: /)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('schedule-error')).toBeVisible()
})
