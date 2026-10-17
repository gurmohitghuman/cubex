// "This sheet's setups just changed": the Use a setup dialog says so when one
// starts, and Stop all when it stops them, and the header's setup chip
// (components/setups/SetupRunChip) reads the sheet's setup runs at once
// instead of waiting for its next look.
type Listener = (sheetId: string) => void
const listeners = new Set<Listener>()

export function onSetupRunsChanged(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function setupRunsChanged(sheetId: string): void {
  for (const fn of listeners) fn(sheetId)
}
