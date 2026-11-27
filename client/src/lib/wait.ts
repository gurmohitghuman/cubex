// Waits ms, or less when signal aborts: true when the time ran out, false when it was stopped. The home asks the
// server again with it after a 429's Retry-After (hooks/useTableRowCounts.ts, useTableRuns.ts).
export function waitFor(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    const done = (ran: boolean) => { clearTimeout(timer); signal.removeEventListener('abort', stopped); resolve(ran) }
    const stopped = () => done(false)
    const timer = setTimeout(() => done(true), ms)
    signal.addEventListener('abort', stopped, { once: true })
  })
}

// Waits until the page is shown again (its tab in front), or less when signal aborts: true when shown. A hidden home
// lets its held waits go (hooks/useTableRuns.ts): on a plain-HTTP install a browser has 6 connections per host for
// every tab, and the sheets' change polls hold one each.
export function whenShown(signal: AbortSignal): Promise<boolean> {
  if (!document.hidden) return Promise.resolve(true)
  if (signal.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    const done = (shown: boolean) => {
      document.removeEventListener('visibilitychange', changed)
      signal.removeEventListener('abort', stopped)
      resolve(shown)
    }
    const changed = () => { if (!document.hidden) done(true) }
    const stopped = () => done(false)
    document.addEventListener('visibilitychange', changed)
    signal.addEventListener('abort', stopped, { once: true })
  })
}
