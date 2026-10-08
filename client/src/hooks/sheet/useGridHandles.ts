import { useCallback, useRef } from 'react'

// Imperative handles AGGridSpreadsheet registers with the page (ref callbacks,
// not a prop drill of grid internals). The register functions keep a stable
// identity so the grid's registering effects don't re-fire every render.
//   - clearSelection: deselectAll through AG Grid, the selection source of
//     truth; the topbar delete confirm deselects the same way the header does.
//   - firstRenderedRow: background reloads refetch around it (reloadWindow.ts).
export function useGridHandles() {
  const clearRef = useRef<(() => void) | null>(null)
  const firstRowRef = useRef<(() => number | null) | null>(null)
  const registerClearSelection = useCallback((clear: (() => void) | null) => { clearRef.current = clear }, [])
  const registerViewport = useCallback((get: (() => number | null) | null) => { firstRowRef.current = get }, [])
  const clearSelection = useCallback(() => clearRef.current?.(), [])
  const firstRenderedRow = useCallback(() => firstRowRef.current?.() ?? null, [])
  return { registerClearSelection, registerViewport, clearSelection, firstRenderedRow }
}
