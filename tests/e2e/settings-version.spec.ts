import fs from 'node:fs'
import path from 'node:path'
import { test, expect, APIRequestContext, Page } from '@playwright/test'
import { authedApi, BASE } from './helpers'
import { bearer, makeToken } from './api-v1-run-helpers'
import { call, mcpClient } from './helpers-mcp'
import { Receiver } from './helpers-receiver'

// Settings → Account → Version. The harness points the release check at this spec's receiver, never
// GitHub (scripts/e2e-env.mjs RELEASE_CHECK_URL), and reads the running version from a folder laid out
// like an install that the spec fills (CUBEX_TEST_HOME). A newer release: the card's line, a dot on the
// dashboard's Settings button and on the Account tab, and GET /api/v1/version and get_version say the
// same; an install pinned with --ref is told how to get updates again instead of cubex update. The same release:
// no dot. Turned off: only the running version, nothing asked. Offline: only the running version, no
// error on the card; "Check now" says it couldn't reach GitHub. Not recorded (Docker): no dot. MCP's
// serverInfo carries the running version.

const PATH = '/repos/gurmohitghuman/cubex/releases/latest'
const HOME = process.env.CUBEX_TEST_HOME || ''
const VERSION_FILE = path.join(HOME, 'app', '.cubex-version')
const INSTALL_ENV = path.join(HOME, 'install.env')
const rx = new Receiver()
let api: APIRequestContext
let v1: APIRequestContext
let token: string

const release = (tag: string) =>
  ({ status: 200, body: JSON.stringify({ tag_name: tag, published_at: '2026-11-12T15:04:05Z' }) })
// Off, then on: the kept answer is deleted, so no dot is left behind for later specs.
async function clearAnswer(): Promise<void> {
  for (const on of [false, true]) {
    const res = await api.put('/api/settings/version', { data: { update_check: on } })
    expect(res.ok(), await res.text()).toBeTruthy()
  }
}
async function openAccount(page: Page): Promise<void> {
  await page.context().addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/settings/account`)
  await expect(page.getByTestId('version-card')).toBeVisible({ timeout: 15_000 })
}

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  if (!HOME) throw new Error('CUBEX_TEST_HOME not set: run via npm run e2e')
  fs.mkdirSync(path.dirname(VERSION_FILE), { recursive: true })
  fs.writeFileSync(path.join(HOME, '.cubex-home'), 'This folder is a Cubex install.\n')
  fs.writeFileSync(VERSION_FILE, 'v0.8.9 e2e0001\n')
  await rx.start()
  api = await authedApi()
  token = await makeToken(api, ['read'], 'version spec')
  v1 = await bearer(token)
  await clearAnswer()
})
test.afterAll(async () => {
  await clearAnswer()
  fs.rmSync(HOME, { recursive: true, force: true })
  await rx.stop()
  await v1?.dispose()
})

test('a newer release: the line, the dots, and REST and MCP agree; the same release: no dot', async ({ page }) => {
  rx.on(PATH, release('v0.8.10'))
  await openAccount(page)
  const card = page.getByTestId('version-card')
  await expect(page.getByTestId('version-running')).toHaveText('Running: v0.8.9 e2e0001')
  await card.getByTestId('version-check-now').click()
  await expect(page.getByTestId('version-latest')).toContainText('Latest release: v0.8.10, Nov 12, 2026.')
  await expect(page.getByTestId('version-update'))
    .toHaveText('v0.8.10 is out (you have v0.8.9). Run cubex update to get it.')
  await expect(card.getByRole('link', { name: 'Release notes' }))
    .toHaveAttribute('href', 'https://github.com/gurmohitghuman/cubex/releases/tag/v0.8.10')
  await expect(page.getByTestId('account-update-dot')).toBeVisible()
  const hit = rx.hitsOn(PATH).at(-1)!
  expect(hit.method).toBe('GET')
  expect(hit.headers['user-agent']).toBe('Cubex')
  expect(hit.headers.cookie).toBeUndefined()

  // The dashboard's Settings button has the dot and opens the Account tab.
  await page.goto(`${BASE}/dashboard`)
  await expect(page.getByTestId('settings-update-dot')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('open-settings').click()
  await expect(page).toHaveURL(/\/settings\/account$/)

  const rest = await (await v1.get('/api/v1/version')).json()
  expect(rest).toMatchObject({
    version: 'v0.8.9', build: 'v0.8.9 e2e0001', pinned_ref: null, update_check: true, update_available: true,
    latest_release: { version: 'v0.8.10', published_at: '2026-11-12T15:04:05.000Z',
      notes_url: 'https://github.com/gurmohitghuman/cubex/releases/tag/v0.8.10' },
  })
  const client = await mcpClient(token)
  try {
    expect(await call(client, 'get_version', {})).toEqual(rest)
    expect(client.getServerVersion()).toEqual({ name: 'cubex', version: 'v0.8.9' })
  } finally { await client.close() }

  // Installed with --ref v0.8.9: cubex update would reinstall it, so the card says how to get updates again.
  fs.writeFileSync(INSTALL_ENV, 'CUBEX_FORMAT=2\nCUBEX_REPO=gurmohitghuman/cubex\nCUBEX_REF=v0.8.9\n')
  await page.reload()
  await expect(page.getByTestId('version-update')).toHaveText('v0.8.10 is out (you have v0.8.9). This install is '
    + 'pinned to v0.8.9. To get updates again, run the install command without --ref.', { timeout: 15_000 })
  expect((await (await v1.get('/api/v1/version')).json()).pinned_ref).toBe('v0.8.9')
  fs.rmSync(INSTALL_ENV)

  // Not recorded (a Docker build): the latest release shows, with how to update, and no dot.
  fs.rmSync(VERSION_FILE)
  await page.reload()
  await expect(page.getByTestId('version-running')).toContainText('not recorded')
  await expect(page.getByTestId('version-how')).toHaveText('See the release notes for how to update.')
  await expect(page.getByTestId('version-update')).toHaveCount(0)
  await expect(page.getByTestId('account-update-dot')).toHaveCount(0)
  const unrecorded = await mcpClient(token)
  try {
    expect(unrecorded.getServerVersion()).toEqual({ name: 'cubex', version: 'unknown' })
  } finally { await unrecorded.close() }
  fs.writeFileSync(VERSION_FILE, 'v0.8.9 e2e0001\n')

  // The same release as the one running: no line, no dots.
  rx.on(PATH, release('v0.8.9'))
  await page.reload()
  await page.getByTestId('version-check-now').click()
  await expect(page.getByTestId('version-current')).toHaveText('You have the latest release.')
  await expect(page.getByTestId('version-update')).toHaveCount(0)
  await expect(page.getByTestId('account-update-dot')).toHaveCount(0)
  await page.goto(`${BASE}/dashboard`)
  await expect(page.getByTestId('open-settings')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('settings-update-dot')).toHaveCount(0)
})

test('turned off: only the running version, no dot, and nothing is asked', async ({ page }) => {
  rx.on(PATH, release('v0.8.10'))
  await openAccount(page)
  await page.getByTestId('version-check-now').click()
  await expect(page.getByTestId('account-update-dot')).toBeVisible()
  const asked = rx.hitsOn(PATH).length
  // A save that fails puts the checkbox, the answer and the dot back.
  const URL_ = '**/api/settings/version'
  await page.route(URL_, r => (r.request().method() === 'PUT'
    ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Failed to save the setting"}' })
    : r.fallback()))
  await page.getByTestId('version-check-toggle').click()
  await expect(page.getByText('Failed to save the setting')).toBeVisible()
  await expect(page.getByTestId('version-check-toggle')).toBeChecked()
  await expect(page.getByTestId('account-update-dot')).toBeVisible()
  await page.unroute(URL_)
  // The toggle shows its new state at once; the reload below waits for the save.
  const saved = page.waitForResponse(r => r.url().endsWith('/api/settings/version') && r.request().method() === 'PUT')
  await page.getByTestId('version-check-toggle').uncheck()
  expect((await saved).ok()).toBeTruthy()
  await expect(page.getByTestId('version-latest')).toHaveCount(0)
  await expect(page.getByTestId('account-update-dot')).toHaveCount(0)
  await expect(page.getByTestId('version-check-now')).toHaveCount(0)
  await expect(page.getByTestId('version-running')).toHaveText('Running: v0.8.9 e2e0001')
  await page.reload()
  await expect(page.getByTestId('version-check-toggle')).not.toBeChecked({ timeout: 15_000 })
  await expect(page.getByTestId('version-latest')).toHaveCount(0)
  const rest = await (await v1.get('/api/v1/version')).json()
  expect(rest).toMatchObject({ update_check: false, latest_release: null, update_available: null })
  expect((await api.post('/api/settings/version/check')).status()).toBe(409)
  await page.goto(`${BASE}/dashboard`)
  await expect(page.getByTestId('open-settings')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('settings-update-dot')).toHaveCount(0)
  expect(rx.hitsOn(PATH).length).toBe(asked)
})

test('offline: only the running version and no error on the card; Check now says so', async ({ page }) => {
  await clearAnswer()
  await rx.stop()
  await openAccount(page)
  await page.getByTestId('version-check-now').click()
  await expect(page.getByText("Couldn't reach GitHub. Try again later.")).toBeVisible()
  const card = page.getByTestId('version-card')
  await expect(page.getByTestId('version-running')).toHaveText('Running: v0.8.9 e2e0001')
  await expect(page.getByTestId('version-latest')).toHaveCount(0)
  await expect(card).not.toContainText(/error|couldn't|failed/i)
  await page.reload()
  await expect(page.getByTestId('version-running')).toHaveText('Running: v0.8.9 e2e0001', { timeout: 15_000 })
  await expect(page.getByTestId('account-update-dot')).toHaveCount(0)
  const rest = await (await v1.get('/api/v1/version')).json()
  expect(rest).toMatchObject({ version: 'v0.8.9', update_check: true, latest_release: null, update_available: null })
  await rx.start()
})
