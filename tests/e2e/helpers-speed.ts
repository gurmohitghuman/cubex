import type { Locator, Page } from '@playwright/test'

// Click to visible, as a person sees it (WORKFLOW Tests step 6: what a click opens is on screen within 100 ms):
// from the click's pointerdown to the first animation frame in which the panel has any part inside the window,
// not see-through. The same clock on both ends (the event's timeStamp and performance.now()). `busy` and
// `content` say what that first frame showed: a loading state, or what was asked for already. `drawn`: to the first
// frame it is in the page at all, on screen or not (a panel sliding in from off screen is drawn frames before).
export interface Opened { ms: number; drawn: number; busy: boolean; content: boolean }

export async function clickToVisible(page: Page, cell: Locator, panel: string, content = ''): Promise<Opened> {
  await page.evaluate(([sel, want]) => {
    const m = { down: null as number | null, ms: null as number | null, drawn: null as number | null, busy: false,
      content: false }
    ;(window as unknown as { __opened: typeof m }).__opened = m
    document.addEventListener('pointerdown', e => { m.down = e.timeStamp }, { capture: true, once: true })
    const seen = (el: Element) => {
      const r = el.getBoundingClientRect()
      let o = 1
      for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity)
      return r.width > 0 && r.height > 0 && r.left < innerWidth - 1 && r.right > 1 && o > 0.05
    }
    const frame = () => {
      const el = m.down === null ? null : document.querySelector(sel)
      if (el && m.drawn === null) m.drawn = performance.now() - m.down!
      if (el && seen(el)) {
        m.ms = performance.now() - m.down!
        m.busy = !!el.querySelector('.animate-spin')
        m.content = !!want && !!el.querySelector(want)
        return
      }
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }, [panel, content])
  await cell.click()
  await page.waitForFunction(() => (window as unknown as { __opened: { ms: number | null } }).__opened.ms !== null,
    null, { timeout: 10_000 })
  return page.evaluate(() => {
    const m = (window as unknown as { __opened: Opened }).__opened
    return { ms: Math.round(m.ms), drawn: Math.round(m.drawn), busy: m.busy, content: m.content }
  })
}

export const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]
