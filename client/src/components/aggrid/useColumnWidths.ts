import { useCallback, useEffect, useRef, useState } from 'react'

type WidthsState = { sheetId: string | undefined; widths: Record<string, number> }

// Load + persist per-sheet column widths in localStorage (key cubex-column-widths-
// ${sheetId}), keyed by column NAME. This hook is the SINGLE owner of that key:
// its save effect rewrites the whole blob whenever the in-memory state changes.
//
// Rename/delete therefore MUST go through this STATE, not localStorage directly.
// They used to write localStorage from useColumnOps, leaving this state stale —
// so a renamed column read its width under the new name, found nothing, and
// snapped to 150px; and the next resize's save effect overwrote the rename's
// localStorage migration with the stale (old-name) state, losing the width for
// good. Deleted columns' width entries were never pruned and could resurrect.
// Now those mutations are reconciled HERE, in state, driven by the same signals
// the colId map already uses (lastRenamedColumn + the live column list).
//
// The state is a BUNDLE of { sheetId, widths } so the two commit together. This
// closes a cross-sheet write race: on a tab switch, `sheetId` becomes the new sheet
// a render before the widths are reloaded; if we tracked "which sheet these widths
// are for" in a ref (mutated synchronously) the save effect could still run with the
// OLD widths while the ref already said NEW, persisting old widths under the new key.
// Bundling makes the save observe both from the SAME committed render, so it only
// writes when state.sheetId === the live sheetId.
export const useColumnWidths = (
  sheetId: string | undefined,
  columns: string[] = [],
  lastRenamedColumn: { from: string; to: string; at: number } | null = null,
) => {
  const [state, setState] = useState<WidthsState>({ sheetId: undefined, widths: {} })
  const [columnWidthsLoaded, setColumnWidthsLoaded] = useState(false)

  // Load when sheetId changes — sets sheetId + widths atomically in one state update.
  useEffect(() => {
    if (!sheetId) {
      setState({ sheetId: undefined, widths: {} })
      setColumnWidthsLoaded(true)
      return
    }
    let widths: Record<string, number> = {}
    try {
      const saved = localStorage.getItem(`cubex-column-widths-${sheetId}`)
      if (saved) widths = JSON.parse(saved)
    } catch (error) {
      console.warn('Failed to load column widths from localStorage:', error)
    }
    setState({ sheetId, widths })
    setColumnWidthsLoaded(true)
  }, [sheetId])

  const columnWidths = state.widths

  // Public setter preserved for downstream callers. Only mutates widths for the CURRENT
  // loaded sheet — a stale updater from the outgoing sheet is dropped (it targets a
  // different sheetId than the state now holds). Accepts a value or updater fn.
  const setColumnWidths = useCallback(
    (update: React.SetStateAction<Record<string, number>>) => {
      setState(prev => {
        const nextWidths = typeof update === 'function'
          ? (update as (w: Record<string, number>) => Record<string, number>)(prev.widths)
          : update
        return nextWidths === prev.widths ? prev : { ...prev, widths: nextWidths }
      })
    }, [])

  // Rename: migrate the width entry from→to IN STATE (mirrors useColIdMap's colId
  // migration off the same signal). Dedupe by `at` so each rename runs once.
  const lastRenameAtRef = useRef<number>(0)
  if (lastRenamedColumn && lastRenamedColumn.at !== lastRenameAtRef.current) {
    lastRenameAtRef.current = lastRenamedColumn.at
    const { from, to } = lastRenamedColumn
    setColumnWidths(prev => {
      if (prev[from] === undefined || from === to) return prev
      const { [from]: w, ...rest } = prev
      return { ...rest, [to]: w }
    })
  }

  // Prune width entries for columns that no longer exist (delete / CSV-replace).
  // Guarded on loaded + a non-empty column list so the pre-load empty `columns` can't
  // wipe a freshly-loaded blob.
  useEffect(() => {
    if (!columnWidthsLoaded || columns.length === 0) return
    const live = new Set(columns)
    setColumnWidths(prev => {
      const next: Record<string, number> = {}
      let changed = false
      for (const [name, w] of Object.entries(prev)) {
        if (live.has(name)) next[name] = w
        else changed = true
      }
      return changed ? next : prev
    })
  }, [columns, columnWidthsLoaded, setColumnWidths])

  // Save on change. Only writes when state.sheetId === the live sheetId (both from the
  // same committed render) so a mid-switch save can't persist the outgoing sheet's
  // widths under the incoming sheet's key. The loaded gate stops the initial empty
  // state clobbering a freshly-loaded value.
  useEffect(() => {
    if (!sheetId || !columnWidthsLoaded || state.sheetId !== sheetId) return
    try {
      localStorage.setItem(`cubex-column-widths-${sheetId}`, JSON.stringify(state.widths))
    } catch (error) {
      console.warn('Failed to save column widths to localStorage:', error)
    }
  }, [state, sheetId, columnWidthsLoaded])

  return { columnWidths, setColumnWidths }
}
