import { expect, type BrowserContext, type Page, type Request } from '@playwright/test'
import { authedApi, BASE } from './helpers'

// Watching a box's reads from the page's side (client/src/lib/typedReads.ts), for typed-reads and click-reads.

export const CSV = ['Name,Website,Tier', 'Maya Chen,https://stripe.com,A', 'Leo Martins,notion.so,B',
  'Ava Patel,figma.com,A', 'Sam Lee,linear.app,'].join('\n')

// aborted: the page dropped it (a newer text), at `end`.
export type Read = { body: string; start: number; end: number | null; aborted: boolean }

// Every read matching `url`: what it asked, when it went, and when its answer was handed back or the page dropped
// it; the first one's answer is held `holdFirstMs`. most(): the most reads on their way at once.
export async function watchReads(page: Page, url: RegExp, holdFirstMs: number) {
  const reads: Read[] = []
  const of = new Map<Request, Read>()
  let open = 0
  let most = 0
  const ended = (r: Read, aborted: boolean) => {
    if (r.end !== null) return
    r.end = Date.now()
    r.aborted = aborted
    open--
  }
  page.on('requestfailed', req => { const r = of.get(req); if (r) ended(r, true) })
  await page.route(url, async route => {
    const r: Read = { body: route.request().postData() ?? route.request().url(), start: Date.now(), end: null,
      aborted: false }
    of.set(route.request(), r)
    const first = reads.push(r) === 1
    most = Math.max(most, ++open)
    try {
      const response = await route.fetch()
      if (first) await new Promise(res => setTimeout(res, holdFirstMs))
      await route.fulfill({ response })
      ended(r, false)
    } catch { ended(r, true) }
  })
  return { reads, most: () => most }
}

// Every text a locator's element showed, from now on (an older answer shown for a moment is caught too).
export async function recordTexts(page: Page, selector: string) {
  await page.evaluate(sel => {
    const seen: string[] = []
    ;(window as unknown as { __seen: string[] }).__seen = seen
    new MutationObserver(() => {
      for (const el of document.querySelectorAll(sel)) seen.push((el.textContent ?? '').trim())
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  }, selector)
  return () => page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)
}

// When the last click and the last key were, in epoch ms like the reads' times.
export async function watchInput(page: Page) {
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

export async function openTable(page: Page, context: BrowserContext, tableId: string) {
  await context.addCookies((await (await authedApi()).storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
}
