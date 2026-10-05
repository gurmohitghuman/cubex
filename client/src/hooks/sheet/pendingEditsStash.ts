// Durable stash for the autosave queue, so un-flushed cell edits survive a hard
// page teardown — specifically the 401 session-expiry redirect (client.ts does
// window.location.href = '/login', which destroys all in-memory React state,
// including unsavedChanges). beforeunload only WARNS; it can't persist. We mirror
// the live queue to localStorage on every change and re-hydrate it on sheet load,
// so a session that expires mid-edit doesn't silently lose the user's last edits.
//
// Keyed per sheet ('cubex-pending-edits-${sheetId}', matching the
// 'cubex-column-widths-${sheetId}' convention) so restore is scoped and a stale
// stash for one sheet can't bleed into another. Entries are the exact CellChange
// shape useCellOps queues; restore feeds them straight back into unsavedChanges
// where the normal autosave flush picks them up.

export interface StashedEdit {
  sheetId: string
  rowIndex: number
  columnName: string
  value: string
  // The sheet's row_generation when this edit was made. A row_index only names a
  // stable row WITHIN one generation — sort/CSV-replace bump the generation and
  // rewrite what each row_index points at. On restore we DISCARD edits whose
  // generation no longer matches the freshly loaded sheet, else we'd write the
  // stale value to whatever row now occupies that index (wrong-row write).
  rowGeneration: number
}

const keyFor = (sheetId: string) => `cubex-pending-edits-${sheetId}`

// Mirror the pending edits for one sheet. Writing [] clears the stash (called
// when the queue drains) so we never restore already-saved edits on next load.
export const stashPendingEdits = (sheetId: string, edits: StashedEdit[]): void => {
  try {
    const key = keyFor(sheetId)
    if (edits.length === 0) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(edits))
  } catch {
    // localStorage can throw (quota, privacy mode). Losing the stash is no worse
    // than today's behavior, so swallow rather than break the edit path.
  }
}

// Read + REMOVE the stash for a sheet (read-once: restoring consumes it, so a
// later genuine reload doesn't re-apply stale edits). Returns [] on miss/parse
// failure. Validates shape defensively — localStorage is user-writable.
export const takeStashedEdits = (sheetId: string): StashedEdit[] => {
  try {
    const raw = localStorage.getItem(keyFor(sheetId))
    if (!raw) return []
    localStorage.removeItem(keyFor(sheetId))
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is StashedEdit =>
      e && typeof e === 'object'
      && e.sheetId === sheetId
      && typeof e.rowIndex === 'number'
      && typeof e.columnName === 'string'
      && typeof e.value === 'string'
      && typeof e.rowGeneration === 'number')
  } catch {
    return []
  }
}
