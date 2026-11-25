import { test, expect, type Page } from '@playwright/test'
import { authedApi, seedSheet, importCsv } from './helpers'
import { bearer, makeToken } from './api-v1-run-helpers'
import { Receiver } from './helpers-receiver'
import { listed, openSheet } from './helpers-paused'

// The sheet header at phone width (390 px), with a run paused on the sheet so Resume and Stop all show: every
// header button is on screen and is what a tap at its middle reaches (nothing lies over it), the row count doesn't
// run into the buttons, and the name stays readable; the header is one row high at desktop width, two on a phone.
const rx = new Receiver()
test.beforeAll(async () => { await rx.start() })
test.afterAll(async () => { await rx.stop() })

async function headerButtons(page: Page) {
  return page.locator('header button:visible, header a[href="/dashboard"]:visible').all()
}

for (const size of [{ name: 'phone', width: 390, height: 844 }, { name: 'desktop', width: 1280, height: 800 }]) {
  const title = `the sheet header at ${size.name} width: every button reachable, nothing overlapping`
  test(title, async ({ page, context }) => {
    test.setTimeout(90_000)
    const api = await authedApi()
    const v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], `header-${size.name}-${Date.now()}`))
    const { tableId, sheetId } = await seedSheet(api, 1)
    expect((await importCsv(api, sheetId, 'Name\nA\nB\nC\nD\nE\nF\nG\n', { replaceData: true })).ok()).toBeTruthy()
    rx.on(`/refuse-${size.name}`, { status: 401, body: '{"error":"bad key"}' })
    const start = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, { data: {
      url: rx.url(`/refuse-${size.name}?n={{Name}}`), master_column_name: 'A rather long column name', batch_size: 1,
      response_mapping: [{ json_path: '$.ok', column_name: 'Long column OK' }],
    } })
    expect(start.status(), await start.text()).toBe(202)
    const runId = (await start.json()).run_id
    await expect.poll(async () => (await listed(api, 'http', sheetId, runId))?.status, { timeout: 30_000 })
      .toBe('paused')
    await page.setViewportSize({ width: size.width, height: size.height })
    await openSheet(page, context, api, tableId)
    await expect(page.getByRole('button', { name: 'Resume', exact: true }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: /Stop all/ })).toBeVisible()

    // A "Paused" toast lies over the header for a few seconds (another item); the header is measured once it goes.
    const pausedToast = page.locator('[role="status"]:not([data-testid="paused-runs-notice"])')
      .filter({ hasText: /paused/i })
    await expect(pausedToast).toHaveCount(0, { timeout: 20_000 })
    const header = page.locator('header').first()
    const box = (await header.boundingBox())!
    // One row from sm up; on a phone two: the name, then the run controls and the menus.
    expect(box.height, 'the header is one row high, two on a phone').toBeLessThanOrEqual(size.width < 640 ? 112 : 64)
    for (const button of await headerButtons(page)) {
      const b = (await button.boundingBox())!
      const label = (await button.getAttribute('aria-label')) ?? (await button.textContent())?.trim()
      expect(b.x >= 0 && b.x + b.width <= size.width + 0.5, `${label} on screen (${b.x}..${b.x + b.width})`).toBe(true)
      const reached = await button.evaluate(el => {
        const r = el.getBoundingClientRect()
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return !!at && (at === el || el.contains(at))
      })
      expect(reached, `${label} is what a tap at its middle reaches`).toBe(true)
    }
    // No two buttons overlap, the row count overlaps none of them, and the sheet name stays readable.
    const boxes = await Promise.all((await headerButtons(page)).map(async b => ({
      label: (await b.getAttribute('aria-label')) ?? (await b.textContent())?.trim() ?? '?',
      box: (await b.boundingBox())!,
    })))
    const overlap = (a: { x: number; y: number; width: number; height: number },
      b: { x: number; y: number; width: number; height: number }) =>
      a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlap(boxes[i].box, boxes[j].box), `${boxes[i].label} and ${boxes[j].label} overlap`).toBe(false)
      }
    }
    const count = (await page.locator('header .meta-label').first().boundingBox())!
    for (const b of boxes) expect(overlap(count, b.box), `the row count runs into ${b.label}`).toBe(false)
    const name = (await page.locator('header h1').first().boundingBox())!
    expect(name.width, 'the sheet name has room to be read').toBeGreaterThanOrEqual(60)
    await page.screenshot({ path: `test-results/sheet-header-${size.name}.png` })
    await v1.post(`/api/v1/http-runs/${runId}/cancel`)
    await v1.dispose()
  })
}
