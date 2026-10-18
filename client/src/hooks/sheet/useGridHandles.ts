import { useCallback, useRef } from 'react'
import type { GridSearchApi } from '@/components/aggrid/types'

// Imperative handles AGGridSpreadsheet registers with the page (ref callbacks,
// not a prop drill of grid internals). The register functions keep a stable
// identity so the grid's registering effects don't re-fire every render.
//   - clearSelection: deselectAll through AG Grid, the selection source of
//     truth; the topbar delete confirm deselects the same way the header does.
//   - firstRenderedRow: background reloads refetch around it (reloadWindow.ts).
//   - search: the grid's highlight + scroll for search (useGridSearch); and the
//     other way, the grid's "/" opens the page's search box (setOpenSearch).
export function useGridHandles() {
  const clearRef = useRef<(() => void) | null>(null)
  const firstRowRef = useRef<(() => number | null) | null>(null)
  const searchRef = useRef<GridSearchApi | null>(null)
  const openSearchRef = useRef<(() => void) | null>(null)
  const registerClearSelection = useCallback((clear: (() => void) | null) => { clearRef.current = clear }, [])
  const registerViewport = useCallback((get: (() => number | null) | null) => { firstRowRef.current = get }, [])
  const registerSearch = useCallback((api: GridSearchApi | null) => { searchRef.current = api }, [])
  const setOpenSearch = useCallback((open: (() => void) | null) => { openSearchRef.current = open }, [])
  const clearSelection = useCallback(() => clearRef.current?.(), [])
  const firstRenderedRow = useCallback(() => firstRowRef.current?.() ?? null, [])
  const search = useCallback(() => searchRef.current, [])
  const openSearch = useCallback(() => openSearchRef.current?.(), [])
  return {
    registerClearSelection, registerViewport, clearSelection, firstRenderedRow,
    registerSearch, search, setOpenSearch, openSearch,
  }
}
