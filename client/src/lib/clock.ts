// The time and timers a pacer reads (hooks/sheet/reloadPacer.ts, lib/typedReads.ts), so a unit test can run
// them on a clock it moves itself.
export interface Clock {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}

// Wrapped: the browser's timer functions throw when called as a method of another object.
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
}
