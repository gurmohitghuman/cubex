// The reads a box makes as a person types or clicks: a rule check, a preview, a search, an estimate. Each box
// has its own TypedReads:
//   - a read starts `waitMs` after the last change (TYPING_WAIT_MS after a key, 0 for a click or a pick:
//     lib/typingWait.ts);
//   - one read of the box at a time: a change while one is on its way starts none, and once it ends the newest
//     text is read, once (a server keeps running most reads the page drops, so dropping them saves nothing);
//   - `cancels` (a read of the whole sheet that the server stops when the page drops it): a change aborts the read
//     on its way instead, so the newest text is read after its own wait, not after an older text's read;
//   - an answer shows only while the box still holds what it was asked for: an older answer never shows.
// The box shows that it is checking from the first change (each hook does that itself).
import { realClock, type Clock } from './clock'
import { TYPING_WAIT_MS } from './constants'

export type ReadAnswer<T> = { key: string; ok: true; value: T } | { key: string; ok: false; error: unknown }
export type Read<T> = (signal: AbortSignal) => Promise<T>

// The server's reason in a failed read's answer, or `fallback`.
export const readError = (error: unknown, fallback: string): string =>
  (error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error || fallback

export interface TypedReadOptions {
  waitMs?: number
  cancels?: boolean
}

export class TypedReads<T> {
  private latest: string | null = null
  private pending: { key: string; read: Read<T>; at: number; waitMs: number } | null = null
  private flight: { key: string; ctrl: AbortController } | null = null
  private timer: unknown = null
  private stopped = false

  constructor(
    private readonly answer: (a: ReadAnswer<T>) => void,
    private readonly opts: TypedReadOptions = {},
    private readonly clock: Clock = realClock,
  ) {}

  // The box now holds `key`. With `read`, its answer is read as above (`waitMs` for this change only, say 0 for a
  // click in a box that is also typed in). Without (an empty box, an answer already at hand), nothing is read: a
  // read on its way still ends (or, with `cancels`, is aborted), and its answer is dropped.
  ask(key: string, read: Read<T> | null, waitMs = this.opts.waitMs ?? TYPING_WAIT_MS): void {
    if (this.stopped) return
    const at = this.pending?.key === key ? this.pending.at : this.clock.now()
    this.latest = key
    if (this.opts.cancels && this.flight && this.flight.key !== key) {
      this.flight.ctrl.abort()
      this.flight = null
    }
    this.pending = read && this.flight?.key !== key ? { key, read, at, waitMs } : null
    this.schedule()
  }

  // The box closed: the read on its way is aborted and nothing more is read or answered.
  stop(): void {
    this.stopped = true
    this.clearTimer()
    this.flight?.ctrl.abort()
    this.flight = this.pending = null
  }

  private clearTimer() {
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private schedule() {
    this.clearTimer()
    const p = this.pending
    if (!p || this.flight) return
    const wait = p.at + p.waitMs - this.clock.now()
    if (wait <= 0) this.fire()
    else this.timer = this.clock.setTimeout(() => { this.timer = null; this.fire() }, wait)
  }

  private fire() {
    const p = this.pending
    if (!p || this.flight || this.stopped) return
    this.pending = null
    const ctrl = new AbortController()
    const flight = { key: p.key, ctrl }
    this.flight = flight
    const done = (a: ReadAnswer<T>) => {
      if (this.flight !== flight) return
      this.flight = null
      if (a.key === this.latest) this.answer(a)
      this.schedule()
    }
    let reading: Promise<T>
    try { reading = p.read(ctrl.signal) } catch (error) { reading = Promise.reject(error) }
    reading.then(
      value => done({ key: p.key, ok: true, value }),
      (error: unknown) => done({ key: p.key, ok: false, error }),
    )
  }
}
