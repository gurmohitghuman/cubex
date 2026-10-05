import { useCallback, useEffect, useRef } from 'react'

// Right-click on a column header opens the same column menu as a left-click.
// Returns the AgGridReact onColumnHeaderContextMenu handler and the ref for the
// grid's wrapper div.
export function useHeaderContextMenu(openColumnMenu: (columnName: string, anchor: DOMRect) => void) {
  // AG Grid hands us a column-event; we look up the header cell's DOM rect.
  const onHeaderContextMenu = useCallback((event: any) => {
    if (event.event?.preventDefault) event.event.preventDefault()
    else if (event.preventDefault) event.preventDefault()

    const colId = event.column?.getColId()
    // ColIds are opaque (col_xxxx); the actual column name is in `field`. The rest of
    // the menu logic keys by column name.
    const columnName = event.column?.getColDef?.()?.field as string | undefined
    if (!colId || !columnName) return

    const headerEl = document.querySelector<HTMLElement>(
      `.ag-theme-alpine .ag-header-cell[col-id="${CSS.escape(colId)}"]`,
    )
    const rect = headerEl?.getBoundingClientRect()
      ?? new DOMRect(event.event?.clientX ?? 0, event.event?.clientY ?? 0)
    openColumnMenu(columnName, rect)
  }, [openColumnMenu])

  // Suppress the native macOS / browser context menu on column headers. AG Grid
  // Community's `onColumnHeaderContextMenu` fires after the native menu is already
  // opening on some browsers (and event.event.preventDefault isn't always wired up),
  // so we install a capture-phase listener directly on the wrapper.
  const wrapperRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const onCtxMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target && target.closest('.ag-header-cell')) e.preventDefault()
    }
    el.addEventListener('contextmenu', onCtxMenu)
    return () => el.removeEventListener('contextmenu', onCtxMenu)
  }, [])

  return { wrapperRef, onHeaderContextMenu }
}
