import { TYPING_MAX_ACTIVE, TYPING_MAX_MS, TYPING_MS_PER_CHAR } from '@/lib/constants'

// One shared animation-frame loop types in every cell that just got its value
// (LoadingCellRenderer). Each cell used to run its own timer and re-render React
// once per character, so a batch of a few hundred cells queued thousands of
// renders on the main thread and every cell typed slower (measured: 5.2 s for
// one 163-char value alone, 9.7 s with 360 cells landing together). Now each
// frame writes every typing cell's visible prefix straight into its span (no
// React render), and a value takes at most TYPING_MAX_MS however long it is.

interface Typer { el: HTMLElement; chars: string[]; start: number; duration: number; shown: number; done: () => void }

const typers = new Set<Typer>()
let frame: number | null = null

function step(now: number): void {
  frame = null
  for (const t of typers) {
    const n = Math.min(t.chars.length, Math.max(0, Math.ceil(t.chars.length * (now - t.start) / t.duration)))
    if (n !== t.shown) { t.el.textContent = t.chars.slice(0, n).join(''); t.shown = n }
    if (n >= t.chars.length) { typers.delete(t); t.done() }
  }
  if (typers.size > 0) frame = requestAnimationFrame(step)
}

// Type `text` into `el` (which React leaves empty); `done` runs once it is all
// shown. Returns the cancel for unmount / a newer value, or null when
// TYPING_MAX_ACTIVE cells are already typing: the rest of a big batch just
// shows its values.
export function startTyping(el: HTMLElement, text: string, done: () => void): (() => void) | null {
  if (typers.size >= TYPING_MAX_ACTIVE) return null
  const chars = Array.from(text) // code points, so an emoji never splits in half
  const t: Typer = {
    el, chars, start: performance.now(), shown: 0, done,
    duration: Math.max(1, Math.min(TYPING_MAX_MS, chars.length * TYPING_MS_PER_CHAR)),
  }
  el.textContent = ''
  typers.add(t)
  if (frame === null) frame = requestAnimationFrame(step)
  return () => { typers.delete(t) }
}
