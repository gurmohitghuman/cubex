// Paces an open tab's background (silent) reloads of a sheet by what each one costs, not by the clock.
//
// A silent reload is not one request: it reads the rows the tab holds (1 to 4 pages of 1,000, reloadWindow.ts)
// and the sheet's run lists, then updates the grid. A change made elsewhere (an /api/v1 write, a webhook, a
// derived column's fill after a run) should show at once, so the first change after a quiet spell reloads at
// once. While changes keep coming, the load stays bounded:
//   - one reload at a time per sheet; a change during a reload is covered by one more reload after it;
//   - after a reload, a rest of RELOAD_REST_FACTOR times its own time, at least RELOAD_REST_MIN_MS and at most
//     RELOAD_REST_MAX_MS, before the next one.
// So the tab spends at most a fifth of its time reloading, never more than one reload a second; a slow server or a
// big window rests longer, up to 15 s. data_version is cumulative, so the reload after a rest shows every change
// that landed during it.
import { realClock, type Clock } from '../../lib/clock'

export const RELOAD_REST_FACTOR = 4
export const RELOAD_REST_MIN_MS = 1_000
export const RELOAD_REST_MAX_MS = 15_000
// The longest the pace waits for one reload to end. Every read in a reload is given up after the client's time
// limit (30 s), so a reload ends well before this; it is here so that a read without one can never stop the pace
// while the page is open. A reload still running past it may yet end and show its rows: an older reload's rows
// never overwrite a newer one's (useSheetLoad orders background reloads' commits).
export const RELOAD_WAIT_MAX_MS = 5 * 60_000

export const reloadRest = (tookMs: number): number =>
  Math.min(RELOAD_REST_MAX_MS, Math.max(RELOAD_REST_MIN_MS, RELOAD_REST_FACTOR * tookMs))

export type PacerClock = Clock

interface Pace {
  busy: boolean
  // A change came during the reload: one more after it.
  again: boolean
  endedAt: number
  rest: number
  timer: unknown | null
}

export class ReloadPacer {
  private readonly sheets = new Map<string, Pace>()
  private stopped = false

  // reload: settles when the reload is done (or failed: it reports its own failure).
  constructor(private readonly reload: (sheetId: string) => Promise<unknown> | unknown,
    private readonly clock: PacerClock = realClock) {}

  // A change to show: reload now, or when the rest after the last reload is over.
  request(sheetId: string): void {
    if (this.stopped) return
    const p = this.pace(sheetId)
    if (p.busy) { p.again = true; return }
    if (p.timer !== null) return // the reload already waiting covers this change
    const wait = p.endedAt + p.rest - this.clock.now()
    if (wait <= 0) { void this.fire(sheetId, p); return }
    p.timer = this.clock.setTimeout(() => { p.timer = null; void this.fire(sheetId, p) }, wait)
  }

  // Drops the reload waiting for a sheet (a rest's timer, or one more after the reload running).
  // True when there was one: the caller still owes that change a reload.
  cancel(sheetId: string): boolean {
    const p = this.sheets.get(sheetId)
    if (!p) return false
    const had = p.timer !== null || p.again
    if (p.timer !== null) this.clock.clearTimeout(p.timer)
    p.timer = null
    p.again = false
    return had
  }

  stop(): void {
    for (const id of this.sheets.keys()) this.cancel(id)
    this.stopped = true
  }

  private pace(sheetId: string): Pace {
    let p = this.sheets.get(sheetId)
    if (!p) {
      p = { busy: false, again: false, endedAt: 0, rest: 0, timer: null }
      this.sheets.set(sheetId, p)
    }
    return p
  }

  private async fire(sheetId: string, p: Pace): Promise<void> {
    p.busy = true
    const started = this.clock.now()
    let giveUp: unknown = null
    try {
      // A reload that ends after the pace gave up on it changes nothing here.
      await Promise.race([
        this.reload(sheetId),
        new Promise<void>(resolve => { giveUp = this.clock.setTimeout(resolve, RELOAD_WAIT_MAX_MS) }),
      ])
    } catch {
      // The reload shows its own failure; the pace goes on.
    } finally {
      this.clock.clearTimeout(giveUp)
      p.busy = false
      p.endedAt = this.clock.now()
      p.rest = reloadRest(p.endedAt - started)
      if (p.again) {
        p.again = false
        this.request(sheetId)
      }
    }
  }
}
