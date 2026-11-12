import { expect, type APIRequestContext, type BrowserContext, type Locator, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { assertTestDb, BASE } from './helpers'

// The sheet's notice of runs that paused themselves (client components/sheet/PausedRunsNotice.tsx), for the
// sheet-paused-*.spec.ts files: open the sheet, find a run's line, read a run as the sheet's list has it, and
// put a pause in place in the test database for the reasons a spec can't bring about (a full disk, a worker
// that keeps stopping, OpenRouter refusing a fetch engine), written as the runner writes them.

// The words each of those reasons saves (server lib/run-pool.ts storageEnd, services/stalled-runs.ts).
export const STORAGE_WORDS = (error: string) => `Results couldn't be saved (${error}), so the run stopped sending `
  + 'calls. Free some disk space, then resume it.'
export const STALLED_WORDS = 'It stopped making progress and was started again several times. Resume it to try '
  + 'once more.'
// A message that reads like markup: it must show as text (a provider's error text can say anything).
export const MARKUP = '<img src=x onerror="window.__pausedNoticeRan=1"><b>disk I/O error</b>'

export async function openSheet(page: Page, context: BrowserContext, api: APIRequestContext, tableId: string) {
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
}

export const notice = (page: Page): Locator => page.getByTestId('paused-runs-notice')
export const pausedLine = (page: Page, runId: string): Locator =>
  page.locator(`[data-testid="paused-run"][data-run-id="${runId}"]`)

// The run's line: its column, "paused:", and its words.
export async function expectLine(page: Page, runId: string, column: string, words: string | RegExp) {
  const line = pausedLine(page, runId)
  await expect(line).toBeVisible({ timeout: 30_000 })
  await expect(line.locator('p')).toContainText(`${column} paused: `)
  await expect(line.locator('p')).toContainText(words)
  return line
}

// A run as the sheet's run list has it (GET /api/ai/runs or /api/http/runs), pause_message included.
export async function listed(api: APIRequestContext, kind: 'ai' | 'http', sheetId: string, runId: string) {
  const res = await api.get(`/api/${kind}/runs`, { params: { sheetId } })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as Array<Record<string, any>>).find(r => r.id === runId) ?? null
}

// A paused run made one that paused itself, as the runner leaves it: its reason and its words.
export function putPause(table: 'ai_runs' | 'http_runs', runId: string, reason: string, words: string) {
  const db = new Database(assertTestDb(process.env.DB_PATH))
  try {
    db.pragma('busy_timeout = 5000')
    const r = db.prepare(`UPDATE ${table} SET pause_reason = ?, error_message = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'paused'`).run(reason, words, runId)
    expect(r.changes, `${runId} is paused`).toBe(1)
  } finally { db.close() }
}

// The notice shows its words as text: no element came from them and nothing in them ran.
export async function expectPlainText(page: Page, runId: string) {
  const line = pausedLine(page, runId)
  await expect(line.locator('p')).toContainText(MARKUP)
  await expect(line.locator('img')).toHaveCount(0)
  await expect(line.locator('b')).toHaveCount(0)
  const ran = await page.evaluate(() => (window as unknown as { __pausedNoticeRan?: number }).__pausedNoticeRan)
  expect(ran).toBeUndefined()
}
