import { useCallback, useEffect, type RefObject } from 'react'
import type { AgGridReact } from 'ag-grid-react'
import type { AGGridSpreadsheetProps } from './types'

// Clear row selection through AG Grid — the REAL source of truth. deselectAll()
// fires onSelectionChanged, which clears BOTH React mirrors (local selectedRows
// + the parent's selectedRowIndices via onSelectedRowsChange) AND un-highlights
// the grid rows. Poking a single React setter (the old setSelectedRows([]))
// left the grid rows visually selected and the other mirror stale. If the grid
// is gone (destroyed/never-mounted), fall back to clearing the mirrors directly.
//
// Also registers that clear with the parent so the TOPBAR delete confirm
// (rendered outside the grid, in SheetModals) can deselect through the same
// source-of-truth path. Ref-callback, not a prop drill of grid internals.
export function useClearRowSelection(
  gridRef: RefObject<AgGridReact>,
  setSelectedRows: (rows: number[]) => void,
  onSelectedRowsChange: AGGridSpreadsheetProps['onSelectedRowsChange'],
  registerClearSelection: AGGridSpreadsheetProps['registerClearSelection'],
): () => void {
  const clearRowSelection = useCallback(() => {
    const api = gridRef.current?.api
    if (api && !api.isDestroyed?.()) api.deselectAll()
    else { setSelectedRows([]); onSelectedRowsChange?.([]) }
  }, [gridRef, setSelectedRows, onSelectedRowsChange])

  useEffect(() => {
    registerClearSelection?.(clearRowSelection)
    return () => registerClearSelection?.(null)
  }, [registerClearSelection, clearRowSelection])

  return clearRowSelection
}
