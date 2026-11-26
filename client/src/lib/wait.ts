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
