import { useEffect, type RefObject } from 'react'
import type { AgGridReact } from 'ag-grid-react'
import type { AGGridSpreadsheetProps } from './types'

// Registers "which row is the grid showing" with the parent: a background
// reload refetches the rows around it (hooks/sheet/reloadWindow.ts) instead of
// the top of the sheet. The first RENDERED row includes AG Grid's rowBuffer
// above the viewport, close enough for that. Null when the grid is gone.
export function useRegisterViewport(
  gridRef: RefObject<AgGridReact>,
  registerViewport: AGGridSpreadsheetProps['registerViewport'],
): void {
  useEffect(() => {
    if (!registerViewport) return
    registerViewport(() => {
      const api = gridRef.current?.api
      return api && !api.isDestroyed?.() ? api.getFirstDisplayedRowIndex() : null
    })
    return () => registerViewport(null)
  }, [gridRef, registerViewport])
}
