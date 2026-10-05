import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  GridApi, GridReadyEvent, CellValueChangedEvent, CellClickedEvent,
  SelectionChangedEvent, ColumnMovedEvent, ColumnResizedEvent, NewColumnsLoadedEvent,
} from 'ag-grid-community'

interface UseGridHandlersArgs {
  columns: string[]
  data: Array<{ rowIndex: number; data: Record<string, string> }>
  totalRows: number
  rowData: Array<{ __rowIndex: number; [k: string]: any }>
  nameToColIdRef: React.MutableRefObject<Map<string, string>>
  colIdFor: (name: string) => string
  setColumnWidths: React.Dispatch<React.SetStateAction<Record<string, number>>>
  setSelectedRows: (rows: number[]) => void
  onCellEdit: (rowIndex: number, column: string, value: string) => void
  onCellClick?: (rowIndex: number, columnName: string, value?: unknown) => void
  onSelectedRowsChange?: (rows: number[]) => void
  onColumnReorder?: (newColumnOrder: string[]) => void | Promise<void>
  onLoadMore?: (offset: number, limit: number) => void
}

export const useGridHandlers = (args: UseGridHandlersArgs) => {
  const {
    columns, data, totalRows, rowData, nameToColIdRef, colIdFor,
    setColumnWidths, setSelectedRows,
    onCellEdit, onCellClick, onSelectedRowsChange, onColumnReorder, onLoadMore,
  } = args

  const [gridApi, setGridApi] = useState<GridApi | null>(null)

  const onGridReady = useCallback((params: GridReadyEvent) => { setGridApi(params.api) }, [])

  // THE single persistence driver for grid-side value mutations. AG Grid
  // fires this for EVERY real change to a cell's value:
  //   - editor commits (source "edit")
  //   - its NATIVE Delete/Backspace clear (source "cellClear", which writes
  //     null directly into node.data with NO editing session — and AG Grid
  //     processes the key BEFORE dispatching the userland cellKeyDown event,
  //     so a key handler reads the already-nulled cell; that's why the old
  //     custom Delete handler silently failed to persist)
  // and — critically — does NOT fire on an Escape-CANCELLED edit. The
  // previous driver, onCellEditingStopped with a `newValue !== oldValue`
  // guard, fired on cancel too (valueChanged=false, newValue=undefined) and
  // saved '' — Escape after typing WIPED the cell and persisted the wipe.
  // Do not reintroduce an editing-stopped save path.
  const onCellValueChanged = useCallback((event: CellValueChangedEvent) => {
    const columnName = event.colDef.field
    const rowIndex = event.data?.__rowIndex
    // Only '__rowIndex' is reserved (it's the row-identity field merged into row
    // data + read by getRowId). Other '__'-prefixed names are legit user columns
    // (e.g. '__source_lsn' from Postgres CDC) and MUST persist edits — don't
    // blanket-skip the whole prefix or their edits silently vanish.
    if (typeof rowIndex !== 'number' || !columnName || columnName === '__rowIndex') return
    // Empty→empty transitions ('' ↔ null) are display noise, not edits.
    const oldEmpty = event.oldValue === null || event.oldValue === undefined || event.oldValue === ''
    const newEmpty = event.newValue === null || event.newValue === undefined || event.newValue === ''
    if (oldEmpty && newEmpty) return
    // Normalize AG Grid's null clears to '' — Cubex cells are strings.
    onCellEdit(rowIndex, columnName, newEmpty ? '' : String(event.newValue))
  }, [onCellEdit])

  const onCellClicked = useCallback((event: CellClickedEvent) => {
    if (onCellClick && event.colDef.field && event.data.__rowIndex !== undefined) {
      onCellClick(event.data.__rowIndex, event.colDef.field, event.value)
    }
  }, [onCellClick])

  const onSelectionChanged = useCallback((_event: SelectionChangedEvent) => {
    const selectedNodes = gridApi?.getSelectedNodes() || []
    // Emit the persistent data row index (__rowIndex), NOT node.rowIndex —
    // that's AG Grid's DISPLAY index, which diverges from our row arrays
    // whenever AG Grid's own sort order differs (e.g. desc sort). Positional
    // indices would map row operations (delete, run) onto the wrong rows.
    const selectedRowIndices = selectedNodes
      .map(node => node.data?.__rowIndex)
      .filter((idx): idx is number => typeof idx === 'number')
    setSelectedRows(selectedRowIndices)
    onSelectedRowsChange?.(selectedRowIndices)
  }, [gridApi, onSelectedRowsChange, setSelectedRows])

  // No onSortChanged handler: the grid never sorts (columns are sortable:false).
  // Sorting is a one-time physical reorder triggered from the header menu —
  // see useSheetView.handleSortChange.

  // Keep AG Grid's internal column order in sync with the `columns` prop. We set
  // maintainColumnOrder={true} so user-dragged orders survive when columns get added
  // (AI run creates new columns). Side effect: AG Grid won't reorder on its own, so on
  // a column rename it'd see the old colId disappear and the new colId arrive at the
  // end. We correct via applyColumnState — but only when AG Grid's current order
  // differs, otherwise it flickers. useLayoutEffect runs before paint; it runs
  // again on newColumnsLoaded, because a column renamed in another tab or over
  // the API gets a NEW colId that AG Grid only adds after this effect has run.
  // Reads the latest columns through a ref: AG Grid can fire newColumnsLoaded with
  // the handler from the previous render, whose `columns` is the pre-rename list.
  const columnsRef = useRef(columns)
  columnsRef.current = columns
  const syncColumnOrder = useCallback((api: GridApi | null = gridApi) => {
    const columns = columnsRef.current
    if (!api || columns.length === 0) return
    // gridApi can be retained in this effect's closure after the <AgGridReact> has
    // unmounted/been destroyed — e.g. an active empty-filter that now matches 0
    // rows flips AGGridSpreadsheet to its zero-row branch (grid destroyed), while
    // a same-cycle `columns` change (a rerun adding a column) re-fires this effect.
    // getColumnState() on a destroyed grid returns undefined → `.map` threw
    // "Cannot read properties of undefined (reading 'map')". Bail if destroyed and
    // coalesce a missing state to [] defensively.
    if (api.isDestroyed?.()) return
    const expectedColIds = columns.map(name => colIdFor(name))
    const currentDataOrder = (api.getColumnState() ?? [])
      .map(c => c.colId!)
      .filter(id => id && !id.startsWith('__') && id !== 'ag-Grid-SelectionColumn')
    const same = currentDataOrder.length === expectedColIds.length &&
      currentDataOrder.every((id, i) => id === expectedColIds[i])
    if (same) return
    api.applyColumnState({
      state: ['__rowNumber', ...expectedColIds, '__addColumn'].map(colId => ({ colId })),
      applyOrder: true,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridApi])
  useLayoutEffect(() => { syncColumnOrder() }, [syncColumnOrder, columns])
  const onNewColumnsLoaded = useCallback((e: NewColumnsLoadedEvent) => syncColumnOrder(e.api), [syncColumnOrder])

  // ColIds are opaque (col_xxxx) so map back to column names via the colId→name reverse.
  // Only a user's drag is saved: the order sync above moves columns through the
  // API too, and saving that put a column renamed elsewhere at the end for good.
  const onColumnMoved = useCallback((event: ColumnMovedEvent) => {
    const byUser = event.source === 'uiColumnMoved' || event.source === 'uiColumnDragged'
    if (event.finished && byUser && onColumnReorder && gridApi && !gridApi.isDestroyed?.()) {
      const colIdToName = new Map<string, string>()
      nameToColIdRef.current.forEach((id, name) => colIdToName.set(id, name))
      const newColumnOrder = (gridApi.getColumnState() ?? [])
        .map(col => col.colId!)
        .filter(colId => colId !== 'ag-Grid-SelectionColumn' && !colId.startsWith('__'))
        .map(colId => colIdToName.get(colId))
        .filter((name): name is string => !!name)
      onColumnReorder(newColumnOrder)
    }
  }, [gridApi, onColumnReorder, nameToColIdRef])

  const onColumnResized = useCallback((event: ColumnResizedEvent) => {
    if (event.finished && event.api) {
      // Save widths keyed by column NAME (colDef.field), not the opaque colId. The
      // read-side in buildColumnDefs looks up `columnWidths[column]` by name.
      const colIdToName = new Map<string, string>()
      nameToColIdRef.current.forEach((id, name) => colIdToName.set(id, name))
      const newWidths: Record<string, number> = {}
      ;(event.api.getColumnState() ?? []).forEach((col: any) => {
        if (col.width !== undefined && col.width > 0) {
          const name = colIdToName.get(col.colId)
          if (name) newWidths[name] = col.width
        }
      })
      setColumnWidths(prev => ({ ...prev, ...newWidths }))
    }
  }, [setColumnWidths, nameToColIdRef])

  const onBodyScrollEnd = useCallback(() => {
    // Same destroyed-grid guard as the column-state handlers — a retained gridApi
    // can outlive its <AgGridReact> (zero-row empty-filter branch).
    if (onLoadMore && gridApi && !gridApi.isDestroyed?.() && data.length < totalRows) {
      const lastRowIndex = gridApi.getLastDisplayedRowIndex()
      if (lastRowIndex >= data.length - 10) onLoadMore(data.length, 1000)
    }
  }, [gridApi, data.length, totalRows, onLoadMore])

  // (Removed) The empty-filter is applied SERVER-SIDE in GET /data now — the
  // server returns only matching rows. The old effect here re-applied an AG Grid
  // client-side column filter ('blank'/'notBlank') on top, which is redundant and
  // could double-filter the already-filtered rows. Header UI still reads
  // emptyFilter directly in AGGridSpreadsheet; this hook no longer needs it.

  return {
    gridApi,
    onGridReady, onCellValueChanged, onCellClicked, onSelectionChanged,
    onColumnMoved, onColumnResized, onBodyScrollEnd, onNewColumnsLoaded,
  }
}
