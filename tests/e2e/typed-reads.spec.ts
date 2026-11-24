// Over 200 lines: one test per kind of box, sharing the read and screen watchers.
import { test, expect, type Page } from '@playwright/test'
import { authedApi, BASE } from './helpers'
import { freshTreg, seedCsv } from './helpers-enrich'
import { seedLeads } from './helpers-dedupe'
import { choose, openColumnType, openDataMenu } from './helpers-ui'

// A box that reads as it is typed in (client/src/lib/typedReads.ts): it says it is checking from the first change,
// reads 200 ms after the last key, one read at a time (the newest text is read once the one on its way ends), and
// an older answer never shows over a newer one. A whole-sheet read (the rule check, row counts) also waits its own
// time after the last one ended. Each test holds the box's first read back, types on meanwhile, and watches every
// read from the page's side. Choices made by clicking read at once (the dedupe check: the older one aborted).

const CSV = ['Name,Website,Tier', 'Maya Chen,https://stripe.com,A', 'Leo Martins,notion.so,B',
  'Ava Patel,figma.com,A', 'Sam Lee,linear.app,'].join('\n')
type Read = { body: string; start: number; end: number | null }

// Every read matching `url`: what it asked, when it went and when its answer was handed back; the first one's
// answer is held `holdFirstMs`.
async function watchReads(page: Page, url: RegExp, holdFirstMs: number) {
  const reads: Read[] = []
  let open = 0
  let most = 0
  await page.route(url, async route => {
    const r: Read = { body: route.request().postData() ?? route.request().url(), start: Date.now(), end: null }
    const first = reads.push(r) === 1
    most = Math.max(most, ++open)
    try {
      const response = await route.fetch()
      if (first) await new Promise(res => setTimeout(res, holdFirstMs))
      await route.fulfill({ response })
    } catch { /* the page dropped it */ } finally { open--; r.end = Date.now() }
  })
  return { reads, most: () => most }
}

// Every text a locator's element showed, from now on (an older answer shown for a moment is caught too).
async function recordTexts(page: Page, selector: string) {
  await page.evaluate(sel => {
    const seen: string[] = []
    ;(window as unknown as { __seen: string[] }).__seen = seen
    new MutationObserver(() => {
      for (const el of document.querySelectorAll(sel)) seen.push((el.textContent ?? '').trim())
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  }, selector)
  return () => page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)
}

// When `selector` first showed, in epoch ms like the reads' times (the page and the test share the machine's clock).
async function watchShown(page: Page, selector: string) {
  await page.evaluate(sel => {
    const w = window as unknown as { __shownAt: number | null }
    w.__shownAt = null
    new MutationObserver(() => {
      if (w.__shownAt === null && document.querySelector(sel)) w.__shownAt = performance.timeOrigin + performance.now()
    }).observe(document.body, { subtree: true, childList: true, attributes: true })
  }, selector)
  return () => page.evaluate(() => (window as unknown as { __shownAt: number | null }).__shownAt)
}

// When the last click and the last key were, in epoch ms like the reads' times.
async function watchInput(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __click: number; __key: number }
    const now = () => performance.timeOrigin + performance.now()
    document.addEventListener('click', () => { w.__click = now() }, true)
    document.addEventListener('keydown', () => { w.__key = now() }, true)
  })
  return () => page.evaluate(() => {
    const w = window as unknown as { __click: number; __key: number }
    return { click: w.__click, key: w.__key }
  })
}

async function open(page: Page, context: import('@playwright/test').BrowserContext, tableId: string) {
  await context.addCookies((await (await authedApi()).storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
}

test('the formula preview: checking at once, one read at a time, the held answer never shown', async ({
  page, context,
}) => {
  test.setTimeout(60_000)
  const { tableId } = await seedCsv(await authedApi(), CSV)
  await open(page, context, tableId)
  const reads = await watchReads(page, /\/formula-columns\/preview$/, 1_500)
  await page.getByRole('button', { name: /add new column/i }).click()
  await page.getByTestId('new-column-formula').click()
  await page.getByTestId('formula-column-form').locator('#formula-name').fill('Shout')
  const seen = await recordTexts(page, '[data-testid=formula-preview] tbody td:last-child')
  const shown = await watchShown(page, '[aria-label="Loading the preview"]')
  const box = page.getByTestId('formula-text')
  await choose(page.getByTestId('formula-insert'), 'Name')
  await expect(page.getByLabel('Loading the preview')).toBeVisible()
  await expect.poll(() => reads.reads.length).toBe(1)
  // Checking shows with the change; the read goes 200 ms later.
  const ahead = reads.reads[0].start - (await shown())!
  expect(ahead, 'checking shows before the read goes').toBeGreaterThan(100)
  await box.press('End')
  await box.pressSequentially('.toUpperCase()', { delay: 40 })
  await expect(page.getByTestId('formula-preview')).toContainText('MAYA CHEN', { timeout: 10_000 })
  expect(reads.reads.length).toBe(2)
  expect(reads.most(), 'never two reads at once').toBe(1)
  expect(JSON.parse(reads.reads[1].body).formula).toBe('{{Name}}.toUpperCase()')
  expect(await seen(), 'the held answer for {{Name}} never shows').not.toContain('Maya Chen')
})

test('the clean preview: a pick reads at once; the name typed in reads after the pause', async ({
  page, context,
}) => {
  test.setTimeout(60_000)
  const { tableId } = await seedCsv(await authedApi(), CSV)
  await open(page, context, tableId)
  const reads = await watchReads(page, /\/clean-columns\/preview$/, 0)
  const input = await watchInput(page)
  await page.getByRole('button', { name: /add new column/i }).click()
  await page.getByTestId('new-column-clean').click()
  const form = page.getByTestId('clean-column-form')
  await choose(form.locator('#clean-source'), 'Name')
  await choose(form.locator('#clean-cleaner'), 'person_name')
  await expect(form).toContainText('Maya Chen', { timeout: 10_000 })
  await expect.poll(() => reads.reads.at(-1)?.end ?? null).not.toBeNull()
  const picked = reads.reads.length
  await choose(form.locator('#clean-cleaner'), 'lowercase')
  await expect(form).toContainText('maya chen', { timeout: 10_000 })
  expect(reads.reads.length, 'one read for the pick').toBe(picked + 1)
  expect(reads.reads[picked].start - (await input()).click, 'a pick reads at once (was 400 ms later)')
    .toBeLessThan(150)
  await expect.poll(() => reads.reads.at(-1)?.end ?? null).not.toBeNull()
  const typed = reads.reads.length
  const name = form.locator('#clean-name')
  await name.selectText()
  await name.pressSequentially('Low', { delay: 40 })
  await expect.poll(() => reads.reads.length).toBe(typed + 1)
  expect(JSON.parse(reads.reads[typed].body).column, 'one read, for the whole name').toBe(await name.inputValue())
  expect(reads.reads[typed].start - (await input()).key, 'typing reads after the pause').toBeGreaterThan(150)
})

test('the rule check: checking at once, one read at a time, the next after a rest as long as the last', async ({
  page, context,
}) => {
  test.setTimeout(60_000)
  const { tableId } = await seedCsv(await authedApi(), CSV)
  await open(page, context, tableId)
  const reads = await watchReads(page, /\/run-conditions\/sheets\/[^/]+\/check/, 1_000)
  await page.getByRole('button', { name: 'AI Column', exact: true }).click()
  await page.getByRole('button', { name: /Only run if/ }).click()
  await page.getByRole('button', { name: 'Add a rule' }).click()
  const rule = page.getByLabel('Rule', { exact: true })
  await rule.pressSequentially('{{Tier}} is "A"', { delay: 20 })
  await expect(page.getByText('Checking the rule…')).toBeVisible()
  await expect.poll(() => reads.reads.length).toBe(1)
  await rule.pressSequentially(' OR {{Name}} contains "sam"', { delay: 40 })
  await expect(page.getByTestId('run-if-check')).toContainText('3 of 4 rows will run', { timeout: 10_000 })
  const [a, b] = reads.reads
  expect(reads.reads.length).toBe(2)
  expect(reads.most(), 'never two reads at once').toBe(1)
  expect(JSON.parse(b.body).rule).toBe('{{Tier}} is "A" OR {{Name}} contains "sam"')
  expect(b.start - a.end!, 'the second waits as long as the first took').toBeGreaterThan(a.end! - a.start - 150)
})

test('Find and the row counts: one read at a time each, the answers for the final text', async ({
  page, context,
}) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const { tableId } = await seedCsv(api, CSV)
  await open(page, context, tableId)
  const tools = await watchReads(page, /\/api\/enrich\/tools\?/, 1_200)
  await openColumnType(page, 'Enrichment')
  const drawer = page.getByTestId('enrich-drawer')
  await expect(drawer.getByTestId('enrich-tool-card').first()).toBeVisible({ timeout: 15_000 })
  const find = page.getByLabel('Search enrichments')
  await find.pressSequentially('work', { delay: 40 })
  const asked = () => tools.reads.map(r => new URL(r.body).searchParams.get('q'))
  await expect.poll(() => asked().filter(q => q === 'work').length).toBe(1)
  await find.pressSequentially(' email', { delay: 40 })
  await expect(drawer.getByTestId('enrich-tool-card').filter({ hasText: /^Verified work email/ })).toBeVisible()
  // "work" finds the card already: the search for the final text is the last one, and ends.
  await expect.poll(() => asked().at(-1)).toBe('work email')
  await expect.poll(() => tools.reads.at(-1)!.end, { timeout: 10_000 }).not.toBeNull()
  expect(tools.most(), 'never two searches at once').toBe(1)

  const counts = await watchReads(page, /\/row-counts$/, 1_000)
  // Its rule is under "Rows and limits" (picking the tool runs nothing).
  await drawer.getByTestId('enrich-tool-card').filter({ hasText: /^Verified work email/ }).click()
  await drawer.getByText('Rows and limits', { exact: true }).click()
  await drawer.getByRole('button', { name: 'Add a rule' }).click()
  const rule = drawer.getByLabel('Rule', { exact: true })
  await rule.pressSequentially('{{Tier}} is "A"', { delay: 20 })
  await expect.poll(() => counts.reads.filter(r => r.body.includes('Tier')).length).toBeGreaterThan(0)
  await rule.pressSequentially(' OR {{Name}} contains "sam"', { delay: 40 })
  await expect.poll(() => counts.reads.at(-1)?.end ?? null, { timeout: 15_000 }).not.toBeNull()
  await expect.poll(() => JSON.parse(counts.reads.at(-1)!.body).runIf)
    .toBe('{{Tier}} is "A" OR {{Name}} contains "sam"')
  expect(counts.most(), 'never two counts at once').toBe(1)
})

test('the dedupe check reads a clicked choice at once; a newer click aborts the older check', async ({
  page, context,
}) => {
  test.setTimeout(60_000)
  const { tableId } = await seedLeads(await authedApi())
  await open(page, context, tableId)
  await openDataMenu(page, 'Remove duplicates')
  const dialog = page.getByRole('dialog')
  const samples = page.getByTestId('dedupe-samples')
  await expect(samples).toContainText('Row 1 stays', { timeout: 15_000 })
  // Each check answers 600 ms late: the clicks come faster than that.
  const sent: number[] = []
  let dropped = 0
  page.on('requestfailed', r => { if (r.url().includes('/duplicates/check')) dropped++ })
  await page.route(/\/duplicates\/check/, async route => {
    sent.push(Date.now())
    const response = await route.fetch()
    await new Promise(res => setTimeout(res, 600))
    await route.fulfill({ response }).catch(() => { /* aborted by a newer choice */ })
  })
  const clicked = Date.now()
  await dialog.getByLabel('Last row').check()
  await dialog.getByLabel('First row').check()
  await dialog.getByLabel('Last row').check()
  await expect(samples).toContainText('Row 6 stays', { timeout: 15_000 })
  expect(sent.length).toBe(3)
  expect(sent[0] - clicked, 'the first click reads at once (was 400 ms later)').toBeLessThan(300)
  expect(dropped, 'the two older checks were aborted').toBe(2)
})
