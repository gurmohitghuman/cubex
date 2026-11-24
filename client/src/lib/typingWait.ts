// How long a box's read waits after the change a person just made (lib/typedReads.ts): TYPING_WAIT_MS after their
// last key in a field they type text into; none after a click, a pick or a toggle, by pointer or by keyboard (a
// space on a checkbox, arrows on a slider, Enter on a menu item). One listener on the page notes what they did last,
// so a box doesn't have to know which of its fields are typed.
import { realClock } from './clock'
import { TYPING_WAIT_MS } from './constants'

const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])
let lastKeyAt = -Infinity

// A field the person types text into, not a checkbox, a slider or a button.
export function typesText(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true
  return target instanceof HTMLInputElement && TEXT_INPUTS.has(target.type)
}

// A key typed into a text field, or any other action.
export function noteAction(typed: boolean, at: number): void {
  lastKeyAt = typed ? at : -Infinity
}

// The wait for a change made now: the rest of the typing wait after the last key typed, else none.
export function typingWait(now = realClock.now()): number {
  return Math.max(0, lastKeyAt + TYPING_WAIT_MS - now)
}

let watching = false
// Starts noting actions (once; the boxes' hook calls it). An input event counts too: some phone keyboards send no
// keys, and a paste from the context menu sends none.
export function watchActions(): void {
  if (watching || typeof document === 'undefined') return
  watching = true
  const note = (typed: boolean) => noteAction(typed, realClock.now())
  document.addEventListener('keydown', e => note(typesText(e.target)), true)
  document.addEventListener('input', e => { if (typesText(e.target)) note(true) }, true)
  document.addEventListener('pointerdown', () => note(false), true)
}
