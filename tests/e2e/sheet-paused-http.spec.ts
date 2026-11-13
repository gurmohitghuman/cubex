import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { authedApi, seedSheet, importCsv } from './helpers'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'
import { Receiver } from './helpers-receiver'
import {
  MARKUP, STALLED_WORDS, STORAGE_WORDS, expectLine, expectPlainText, listed, notice, openSheet, pausedLine, putPause,
} from './helpers-paused'

// HTTP API runs that paused themselves, on the sheet (components/sheet/PausedRunsNotice.tsx): a line under the
// header names the column and says why, in the words the run saved, beside a Resume for that run, and Resume
// carries the run on. provider_errors comes from the receiver failing row after row; storage and stalled (a full
// disk, a worker that keeps stopping) are put in place in the test database as the runner writes them. Also: the
// line next to the header's Pause and Resume when one run paused itself and another didn't, and a sheet with more
// paused runs than the notice lists.
const rx = new Receiver()
let api: APIRequestContext
let v1: APIRequestContext
const OK = { status: 200, body: '{"ok":"up"}' }
const REFUSED = { status: 401, body: '{"error":"bad key"}' }
const BRAKE = /5 rows in a row failed on the provider's side, so the run paused\. Resume once it works again/

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await rx.start()
  api = await authedApi()
  v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'sheet paused http spec'))
})
test.afterAll(async () => { await rx.stop(); await v1?.dispose() })

async function sheetOf(rows: number): Promise<{ tableId: string; sheetId: string }> {
  const s = await seedSheet(api, 1)
  const csv = ['Name', ...Array.from({ length: rows }, (_, i) => `P${i}`)].join('\n')
  expect((await importCsv(api, s.sheetId, csv, { replaceData: true })).ok()).toBeTruthy()
  return s
}
async function run(sheetId: string, path: string, column: string): Promise<string> {
  const res = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, { data: {
    // One row at a time: the brake's fifth failure leaves rows still to run, so the run pauses.
    url: rx.url(`${path}?n={{Name}}`), master_column_name: column, batch_size: 1,
    response_mapping: [{ json_path: '$.ok', column_name: `${column} OK` }],
  } })
  expect(res.status(), await res.text()).toBe(202)
  return (await res.json()).run_id
}
const statusOf = async (sheetId: string, runId: string) => {
  const r = await listed(api, 'http', sheetId, runId)
  return r ? `${r.status}/${r.pause_reason ?? ''}` : ''
}
const finished = async (runId: string) => (await waitForTerminal(v1, `/api/v1/http-runs/${runId}`)).status
const control = async (runId: string, action: 'pause' | 'resume' | 'cancel') =>
  expect((await api.post(`/api/http/jobs/${runId}/control`, { data: { action } })).ok()).toBeTruthy()

// A run whose path refuses every call (401 counts as the provider's side), paused by its brake.
async function braked(sheetId: string, path: string, column: string): Promise<string> {
  rx.on(path, REFUSED)
  const runId = await run(sheetId, path, column)
  await expect.poll(() => statusOf(sheetId, runId), { timeout: 30_000 }).toBe('paused/provider_errors')
  return runId
}
// A run paused by hand while its first call is held; release() lets that call answer.
async function pausedByHand(sheetId: string, path: string, column: string) {
  rx.on(path, OK)
  const release = rx.hold([path])
  const runId = await run(sheetId, path, column)
  await rx.waitFor(path, 1)
  await control(runId, 'pause')
  await expect.poll(() => statusOf(sheetId, runId), { timeout: 15_000 }).toBe('paused/')
  return { runId, release }
}
const resumeLine = (page: Page, runId: string, column: string) =>
  pausedLine(page, runId).getByRole('button', { name: `Resume ${column}` }).click()

test('provider_errors: the line says rows kept failing; once it answers, its Resume finishes the run', async ({
  page, context,
}) => {
  const { tableId, sheetId } = await sheetOf(12)
  const runId = await braked(sheetId, '/p-down', 'Down')
  expect((await listed(api, 'http', sheetId, runId))!.pause_message).toMatch(BRAKE)
  await openSheet(page, context, api, tableId)
  await expectLine(page, runId, 'Down', BRAKE)
  rx.on('/p-down', OK)
  await resumeLine(page, runId, 'Down')
  expect(await finished(runId)).toBe('completed')
  await expect(pausedLine(page, runId)).toBeHidden({ timeout: 15_000 })
  expect(rx.hitsOn('/p-down').length).toBeGreaterThan(5)
})

for (const c of [
  { reason: 'storage', words: STORAGE_WORDS(MARKUP), tail: 'Free some disk space, then resume it.' },
  { reason: 'stalled', words: STALLED_WORDS, tail: 'Resume it to try once more.' },
]) {
  test(`${c.reason} (put in place): the line shows the saved words as text, and Resume finishes the run`, async ({
    page, context,
  }) => {
    const { tableId, sheetId } = await sheetOf(3)
    const { runId, release } = await pausedByHand(sheetId, `/p-${c.reason}`, 'Saved')
    putPause('http_runs', runId, c.reason, c.words)
    expect((await listed(api, 'http', sheetId, runId))!.pause_message).toBe(c.words)
    await openSheet(page, context, api, tableId)
    await expectLine(page, runId, 'Saved', c.tail)
    if (c.reason === 'storage') await expectPlainText(page, runId)
    release()
    await resumeLine(page, runId, 'Saved')
    expect(await finished(runId)).toBe('completed')
    await expect(pausedLine(page, runId)).toBeHidden({ timeout: 15_000 })
  })
}

test("one run paused itself, one didn't: the header's Pause and Resume and the line's Resume agree", async ({
  page, context,
}) => {
  test.setTimeout(120_000)
  const { tableId, sheetId } = await sheetOf(8)
  // Slow keeps running (its calls held); Down paused itself.
  rx.on('/p-slow', OK)
  const releaseSlow = rx.hold(['/p-slow'])
  const slow = await run(sheetId, '/p-slow', 'Slow')
  await rx.waitFor('/p-slow', 1)
  const down = await braked(sheetId, '/p-down2', 'Down')
  await openSheet(page, context, api, tableId)
  await expectLine(page, down, 'Down', BRAKE)
  await expect(pausedLine(page, slow)).toHaveCount(0)
  // The header offers Pause (Slow runs): it pauses Slow, and Down's line stays as it was.
  await page.getByTitle('Pause all runs').click()
  await expect.poll(() => statusOf(sheetId, slow)).toBe('paused/')
  await expect(page.getByTitle('Resume all runs')).toBeVisible()
  await expectLine(page, down, 'Down', BRAKE)
  await expect(notice(page).getByTestId('paused-run')).toHaveCount(1)
  // The line's Resume carries Down on alone; Slow stays paused.
  rx.on('/p-down2', OK)
  await resumeLine(page, down, 'Down')
  expect(await finished(down)).toBe('completed')
  await expect(notice(page)).toBeHidden({ timeout: 15_000 })
  expect(await statusOf(sheetId, slow)).toBe('paused/')
  // The header's Resume carries on a run that paused itself the same way, and one paused by hand.
  const again = await braked(sheetId, '/p-down3', 'Again')
  await expectLine(page, again, 'Again', BRAKE)
  rx.on('/p-down3', OK)
  releaseSlow()
  await page.getByTitle('Resume all runs').click()
  expect(await finished(again)).toBe('completed')
  expect(await finished(slow)).toBe('completed')
  await expect(notice(page)).toBeHidden({ timeout: 15_000 })
})

test('more paused runs than the notice lists: the first three, then how many more', async ({ page, context }) => {
  test.setTimeout(120_000)
  const { tableId, sheetId } = await sheetOf(6)
  const runs: string[] = []
  for (let i = 0; i < 5; i++) runs.push(await braked(sheetId, `/p-many${i}`, `Many ${i}`))
  await openSheet(page, context, api, tableId)
  await expect(notice(page).getByTestId('paused-run')).toHaveCount(3)
  await expect(page.getByTestId('paused-runs-more')).toHaveText('And 2 more paused runs.')
  for (const runId of runs) await control(runId, 'cancel')
  await expect(notice(page)).toBeHidden({ timeout: 15_000 })
})
