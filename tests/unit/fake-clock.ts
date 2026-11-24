// A clock whose time moves only when the test moves it, running its timers in order (client/src/lib/clock.ts):
// for the pacers' unit tests. No waiting.
import type { Clock } from '../../client/src/lib/clock'

export const settle = () => new Promise<void>(r => setImmediate(r))

export class FakeClock implements Clock {
  t = 0
  private timers: Array<{ at: number; fn: () => void; id: number }> = []
  private nextId = 1
  now = () => this.t
  setTimeout = (fn: () => void, ms: number) => {
    this.timers.push({ at: this.t + ms, fn, id: this.nextId })
    return this.nextId++
  }
  clearTimeout = (id: unknown) => { this.timers = this.timers.filter(x => x.id !== id) }
  async advanceTo(at: number) {
    for (;;) {
      await settle()
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id)
      const next = this.timers[0]
      if (!next || next.at > at) break
      this.timers.shift()
      this.t = next.at
      next.fn()
    }
    this.t = at
    await settle()
  }
}
