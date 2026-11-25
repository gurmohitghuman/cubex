// Over 200 lines: both panels' moves share one frame sampler and one 10,000-row sheet (seeded once, about 20 s).
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { Receiver } from './helpers-receiver'
import { median } from './helpers-speed'
import { PANEL_ROWS, cellOf, colId, openTable, seedCellPanels } from './helpers-cell-panels'

// WORKFLOW "No flash": moving to another row while a panel is open never blanks it or plays its entry again. On a
// sheet of 10,000 rows, with every frame sampled: the header names the new row at once, with a small spinner while
// its answer comes; the last answer stays below it until the new one is ready and swaps in, and nothing acts on the
// old answer meanwhile (Rerun this row, Copy diagnostics and Add as column wait). The trace panel the same. Answer to
// trace and back doesn't slide in again; from closed it still does. The numbers (click to the new row's header, click
// to its answer) are logged; the header has the side panels' budget (cell-panels-speed.spec.ts). The spinner and the
// waiting buttons' dim show only once a wait passes 300 ms (index.css .cube-wait-mark): a slow answer shows them, and
// no frame before 300 ms does.
// A trace records the page as it goes, which slows the very frames sampled here: none in this file.
test.use({ trace: 'off' })

const HEADER_BUDGET_MS = 150
const WAIT_SHOWS_MS = 300
const rx = new Receiver()
let api: APIRequestContext
let tableId = ''

test.beforeAll(async () => {
  test.setTimeout(120_000)
  await rx.start()
  const seeded = await seedCellPanels(rx)
  api = seeded.api
  tableId = seeded.tableId
})
test.afterAll(async () => { await rx.stop(); await api?.dispose() })

interface Frame {
  t: number; title: string; body: string; buttons: number; enabled: number; spin: boolean; seen: boolean; dim: boolean
  top: number
}
interface Watched { frames: Frame[]; clicks: number[]; loading: boolean; mounted: string[][] }

// From here on, each frame a side panel is on screen: its title, what its body shows ('row N' for an answer naming
// companyN, 'trace', 'loading' or 'blank'), its buttons and how many act, whether its header has the wait mark and
// whether that is seen yet, whether a button is dimmed, and how far its body is scrolled. Also each
// click's time, whether "Loading the answer…" was ever in the page (painted or not), and each side panel put on the
// page with the animations it started with.
async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const m: Watched = { frames: [], clicks: [], loading: false, mounted: [] }
    ;(window as unknown as { __w: Watched }).__w = m
    document.addEventListener('pointerdown', e => { m.clicks.push(e.timeStamp) }, { capture: true })
    new MutationObserver(records => {
      for (const r of records) for (const n of Array.from(r.addedNodes)) {
        if (n instanceof HTMLElement && n.dataset.testid === 'side-panel') {
          m.mounted.push(n.getAnimations().map(a => (a as CSSAnimation).animationName))
        }
      }
      if (document.querySelector('[data-testid=answer-panel]')?.textContent?.includes('Loading the answer')) {
        m.loading = true
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
    const frame = () => {
      const p = document.querySelector('[data-testid=side-panel]')
      if (p) {
        const h2 = p.querySelector('h2')
        const row = /company(\d+)\.example/.exec(p.querySelector('[data-testid=answer-result]')?.textContent ?? '')
        const buttons = Array.from(p.querySelectorAll<HTMLButtonElement>(
          '[data-testid=answer-rerun], [data-testid=answer-copy], [data-testid=trace-rerun]'))
        const mark = p.querySelector('[data-testid=panel-wait]')
        m.frames.push({
          t: performance.now(), title: h2?.textContent ?? '',
          body: row ? `row ${row[1]}` : p.querySelector('[data-testid=waterfall-trace-step]') ? 'trace'
            : p.textContent?.includes('Loading the answer') ? 'loading' : 'blank',
          buttons: buttons.length, enabled: buttons.filter(b => !b.disabled).length,
          spin: !!mark, seen: !!mark && Number(getComputedStyle(mark).opacity) > 0,
          dim: buttons.some(b => Number(getComputedStyle(b).opacity) < 1),
          top: p.querySelector('.overflow-y-auto')?.scrollTop ?? 0,
        })
      }
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
}
const watched = (page: Page) => page.evaluate(() => (window as unknown as { __w: Watched }).__w)
const rowOf = (title: string) => Number(/^Row ([\d,]+)/.exec(title)?.[1]?.replace(/,/g, '') ?? NaN)
// Frames whose buttons don't match what they show: while the header names a row whose answer isn't there yet, it
// spins and no button acts; once it is, it doesn't spin and every button acts.
const mismatched = (frames: Frame[], fresh: (f: Frame) => boolean) => frames.filter(f => fresh(f)
  ? f.spin || f.enabled !== f.buttons || f.buttons === 0 : !f.spin || f.enabled !== 0)
// Frames that show the wait (the mark seen, a button dimmed) sooner than 300 ms after the click before them.
const early = (w: Watched) => w.frames.filter(f => (f.seen || f.dim)
  && f.t - Math.max(...w.clicks.filter(c => c <= f.t)) < WAIT_SHOWS_MS)

test('row to row: the answer never blanks; the old one stays, its actions off, until the new one swaps in', async ({
  page, context,
}) => {
  test.setTimeout(90_000)
  await openTable(page, context, api, tableId, 2560)
  const email = await colId(page, 'Work email')
  const answer = page.getByTestId('answer-panel')
  const result = page.getByTestId('answer-result')
  // One row's answer can be held (a slow answer), and one can fail.
  let hold = -1
  let fail = -1
  let held = Promise.resolve()
  let letGo = () => {}
  await page.route(/\/api\/enrich\/sheets\/[^/]+\/answer\?/, async route => {
    const row = Number(new URL(route.request().url()).searchParams.get('row'))
    if (row === fail) return route.fulfill({ status: 500, json: { error: 'The answer could not be read.' } })
    if (row === hold) await held
    await route.continue()
  })
  await cellOf(page, email, 0).click()
  await expect(result).toContainText('company1.example')
  await watch(page)

  // Rows 2 to 5, one after another, each as fast as its answer comes.
  for (let row = 1; row < 5; row++) {
    await cellOf(page, email, row).click()
    await expect(answer.locator('h2')).toHaveText(`Row ${row + 1} · Work email`)
    await expect(result).toContainText(`company${row + 1}.example`)
  }
  // Frames are recorded one an animation frame: row 5's text can be in the page a frame before the recorder has
  // drawn it. Read them once there is a frame of each row's header and answer after its click.
  let moved = await watched(page)
  await expect.poll(async () => {
    moved = await watched(page)
    return moved.clicks.every((c, i) => moved.frames.some(f => f.t >= c && f.title === `Row ${i + 2} · Work email`)
      && moved.frames.some(f => f.t >= c && f.body === `row ${i + 2}`))
  }, { timeout: 5_000 }).toBe(true)
  const after = (i: number, ok: (f: Frame) => boolean) =>
    Math.round(moved.frames.find(f => f.t >= moved.clicks[i] && ok(f))!.t - moved.clicks[i])
  const header = moved.clicks.map((_, i) => after(i, f => f.title === `Row ${i + 2} · Work email`))
  const shown = moved.clicks.map((_, i) => after(i, f => f.body === `row ${i + 2}`))
  const empty = moved.frames.filter(f => !f.body.startsWith('row ')).length
  console.log(`row to row, ${PANEL_ROWS.toLocaleString()} rows: click to the new header ${header.join(', ')} ms; to its`
    + ` answer ${shown.join(', ')} ms; frames with no answer ${empty} of ${moved.frames.length}`)

  // A slow answer (row 1 again), with row 5's answer scrolled down: the header names it at once and spins; row 5's
  // answer stays where it was, and its buttons and the tree's Add as column wait. Row 1's opens at its top.
  await page.setViewportSize({ width: 2560, height: 500 })
  const body = answer.locator('.overflow-y-auto')
  await body.evaluate(el => { el.scrollTop = el.scrollHeight })
  expect(await body.evaluate(el => el.scrollTop), 'row 5\'s answer scrolled down').toBeGreaterThan(0)
  held = new Promise<void>(r => { letGo = r })
  hold = 0
  await cellOf(page, email, 0).click()
  await expect(answer.locator('h2')).toHaveText('Row 1 · Work email')
  await expect(result).toContainText('company5.example')
  expect(await body.evaluate(el => el.scrollTop), 'row 5\'s answer where it was').toBeGreaterThan(0)
  await expect(page.getByTestId('answer-rerun')).toBeDisabled()
  await expect(page.getByTestId('answer-copy')).toBeDisabled()
  await expect(page.getByTestId('answer-tree')).toHaveCSS('pointer-events', 'none')
  await expect(page.getByTestId('panel-wait')).toHaveCSS('opacity', '1')
  await expect(page.getByTestId('answer-rerun')).toHaveCSS('opacity', '0.5')
  letGo()
  await expect(result).toContainText('company1.example')
  await expect(page.getByTestId('panel-wait')).toHaveCount(0)
  await expect(page.getByTestId('answer-rerun')).toBeEnabled()
  await expect(page.getByTestId('answer-rerun')).toHaveCSS('opacity', '1')
  await expect(page.getByTestId('answer-copy')).toBeEnabled()
  await expect(page.getByTestId('answer-tree')).toHaveCSS('pointer-events', 'auto')

  const w = await watched(page)
  expect(w.frames.filter(f => !f.body.startsWith('row ')), 'frames with no answer, row to row').toEqual([])
  expect(w.loading, '"Loading the answer…" in the page, row to row').toBe(false)
  expect(mismatched(w.frames, f => `row ${rowOf(f.title)}` === f.body), 'frames whose buttons and spinner are off')
    .toEqual([])
  expect(early(w), 'frames showing the wait before 300 ms').toEqual([])
  const slow = w.clicks[w.clicks.length - 1]
  expect(w.frames.find(f => f.t >= slow && f.body === 'row 1')?.top, 'row 1\'s answer, first drawn').toBe(0)
  const markSeen = Math.round(w.frames.find(f => f.seen)!.t - slow)
  console.log(`a slow answer: its wait mark seen ${markSeen} ms after the click`)
  expect(median(header), 'median click to the new row\'s header').toBeLessThan(HEADER_BUDGET_MS)

  // A new answer that fails: the old one goes, and the error says so.
  fail = 2
  await cellOf(page, email, 2).click()
  await expect(page.getByTestId('answer-error')).toHaveText('The answer could not be read.')
  await expect(result).toHaveCount(0)
})

test('the trace the same; answer to trace and back slides in only from closed', async ({ page, context }) => {
  test.setTimeout(90_000)
  await openTable(page, context, api, tableId, 2560)
  const [found, email] = [await colId(page, 'Found email'), await colId(page, 'Work email')]
  const steps = page.getByTestId('waterfall-trace-step')
  const rerun = page.getByTestId('trace-rerun')
  let hold = -1
  let held = Promise.resolve()
  let letGo = () => {}
  await page.route(/\/api\/waterfall\/sheets\/[^/]+\/trace\?/, async route => {
    if (Number(new URL(route.request().url()).searchParams.get('row')) === hold) await held
    await route.continue()
  })
  await watch(page)
  await cellOf(page, found, 0).click()
  await expect(steps.first()).toBeVisible()
  await expect(rerun).toBeEnabled()
  const opened = (await watched(page)).frames.length

  // Rows 2 to 5, then a slow one (row 1 again): the header names it at once and spins, the last trace stays, and
  // "Run this row again" waits.
  for (let row = 1; row < 5; row++) {
    const read = page.waitForResponse(r => r.url().includes('/trace?') && r.url().includes(`row=${row}`))
    await cellOf(page, found, row).click()
    await expect(page.getByTestId('side-panel').locator('h2')).toHaveText(`Row ${row + 1}`)
    await read
    await expect(rerun).toBeEnabled()
  }
  held = new Promise<void>(r => { letGo = r })
  hold = 0
  await cellOf(page, found, 0).click()
  await expect(page.getByTestId('side-panel').locator('h2')).toHaveText('Row 1')
  await expect(steps.first()).toBeVisible()
  await expect(rerun).toBeDisabled()
  await expect(page.getByTestId('panel-wait')).toHaveCSS('opacity', '1')
  await expect(rerun).toHaveCSS('opacity', '0.5')
  letGo()
  await expect(rerun).toBeEnabled()
  await expect(page.getByTestId('panel-wait')).toHaveCount(0)
  const w = await watched(page)
  const moving = w.frames.slice(opened)
  expect(moving.filter(f => f.body !== 'trace'), 'frames with no trace, row to row').toEqual([])
  expect(mismatched(moving, f => !f.spin), 'frames whose button and spinner are off').toEqual([])
  expect(early(w), 'frames showing the wait before 300 ms').toEqual([])

  // Trace to answer and back: no slide; closed, then opened: it slides in as before.
  await cellOf(page, email, 0).click()
  await expect(page.getByTestId('answer-result')).toContainText('company1.example')
  await cellOf(page, found, 1).click()
  await expect(steps.first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('side-panel')).toHaveCount(0)
  await cellOf(page, email, 1).click()
  await expect(page.getByTestId('answer-result')).toContainText('company2.example')
  expect((await watched(page)).mounted, 'the slide each panel started with').toEqual([
    ['cubeSidePanelIn'], [], [], ['cubeSidePanelIn'],
  ])
})
