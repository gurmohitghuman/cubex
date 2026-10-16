// "A setup just started on this sheet": the Use a setup dialog says so, and the
// header's setup chip (components/setups/SetupRunChip) reads the sheet's setup
// runs at once instead of waiting for its next look.
type Listener = (sheetId: string) => void
const listeners = new Set<Listener>()

export function onSetupStarted(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function setupStarted(sheetId: string): void {
  for (const fn of listeners) fn(sheetId)
}
