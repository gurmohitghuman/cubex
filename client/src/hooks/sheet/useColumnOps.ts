import { useCallback, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { sheetsAPI, Sheet, SheetData } from '@/utils/api'
import { useColumnRename } from './useColumnRename'
import { useColumnReorder } from './useColumnReorder'

interface UseColumnOpsArgs {
  activeSheet: Sheet | null
  sheetData: SheetData | null
  setSheetData: React.Dispatch<React.SetStateAction<SheetData | null>>
  setEmptyFilter: React.Dispatch<React.SetStateAction<Record<string, 'empty' | 'not_empty'>>>
  // Text-filter state migrated on rename / pruned on delete (same reason the
  // server reconciles column_filters; a stale key 400s later filter PUTs).
  setColumnFilters: React.Dispatch<React.SetStateAction<Record<string, { type: 'contains'; value: string }>>>
  // Autosave reconciliation — delete/rename must flush or purge pending cell
  // edits keyed on the affected column, or a stale flush re-creates it (the
  // PUT upsert re-registers any column it writes). Mirrors the sort barrier.
  waitForSaves: (timeoutMs?: number) => Promise<boolean>
  dropPendingForColumn: (columnName: string) => void
  renamePendingColumn: (oldName: string, newName: string) => void
  // Freeze flushing during the rename round-trip so a straggler edit on the old
  // name can't reach the server after the rename commits (which would resurrect
  // the old column). Edits still queue; we remap then unpause.
  setAutosavePaused: (paused: boolean) => void
}

export const useColumnOps = ({
  activeSheet, sheetData, setSheetData, setEmptyFilter, setColumnFilters,
  waitForSaves, dropPendingForColumn, renamePendingColumn, setAutosavePaused,
}: UseColumnOpsArgs) => {
  const [columnOrder, setColumnOrder] = useState<string[]>([])
  // Signal to AGGridSpreadsheet so it can preserve a column's stable colId across a rename
  // — otherwise AG Grid sees the field change as remove+add and snaps the renamed column
  // to the end of the row.
  const [lastRenamedColumn, setLastRenamedColumn] =
    useState<{ from: string; to: string; at: number } | null>(null)

  // Resolves false when the column wasn't added, so the dialog keeps the name.
  const handleAddColumn = useCallback(async (columnName: string): Promise<boolean> => {
    if (!activeSheet) return false
    // Collapse internal whitespace to match the server's canonical column name
    // (sanitizeColumnName). The optimistic update below uses this name; if we
    // kept "First  Name" while the server stored "First Name", the grid would
    // show a column whose key no cell write resolves to until reload (M6).
    const name = columnName.trim().replace(/\s+/g, ' ')
    if (!name) {
      toast.error('Column name is required')
      return false
    }
    const existing = (sheetData?.data.columns || []).some(c => c.toLowerCase() === name.toLowerCase())
    if (existing) {
      toast.error('A column with that name already exists')
      return false
    }
    try {
      const stored = await sheetsAPI.addColumn(activeSheet.id, name)
      // Optimistic update — server appends new columns to column_order via
      // appendColumnsToOrder, so appending locally matches exactly. AG Grid mints
      // a fresh colId for the new field on first sighting (lazy via colIdFor),
      // and the column-width map falls back to 150px until the user resizes.
      // No reload needed. Uses the stored name: the server may have stripped
      // characters a name can't hold.
      setSheetData(prev => prev ? {
        ...prev,
        data: prev.data.columns.includes(stored)
          ? prev.data
          : { ...prev.data, columns: [...prev.data.columns, stored] },
      } : prev)
      setColumnOrder(prev => prev.includes(stored) ? prev : [...prev, stored])
      // No success toast — the new column appears in the grid immediately.
      return true
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to add column')
      return false
    }
  }, [activeSheet, sheetData, setSheetData])

  const handleColumnDelete = useCallback(async (columnName: string) => {
    if (!activeSheet) return
    // Reconcile the autosave queue before deleting, or the upsert PUT
    // re-registers the column (appendColumnsToOrder re-adds any column the PUT
    // writes). Flush in-flight/queued writes first (an in-flight PUT can't be
    // recalled — let it land, then delete on top), then drop stragglers for
    // this column so they aren't re-sent post-delete. Same pattern as
    // handleDeleteRows / sort.
    const flushed = await waitForSaves(5000)
    if (!flushed) {
      toast.error("Couldn't save your pending edits; delete cancelled. Check your connection and try again.")
      return
    }
    dropPendingForColumn(columnName)
    try {
      await sheetsAPI.deleteColumn(activeSheet.id, columnName)
      setSheetData(prev => {
        if (!prev) return prev
        const updatedRows = prev.data.rows.map(row => ({
          ...row,
          data: Object.fromEntries(
            Object.entries(row.data).filter(([key]) => key !== columnName),
          ),
        }))
        return {
          ...prev,
          data: {
            ...prev.data,
            columns: prev.data.columns.filter(col => col !== columnName),
            rows: updatedRows,
          },
        }
      })
      setColumnOrder(prev => prev.filter(col => col !== columnName))
      // The server prunes empty_filter for the deleted column in the same
      // transaction; mirror it locally so a stale filter (e.g. 'not_empty' on
      // the gone column) doesn't keep hiding every row until a reload.
      setEmptyFilter(prev => {
        if (!(columnName in prev)) return prev
        const { [columnName]: _removed, ...rest } = prev
        return rest
      })
      // Same for the text ("contains") filter — a stale key here 400s every
      // later filter PUT and leaves the filter unclearable until a reload.
      setColumnFilters(prev => {
        if (!(columnName in prev)) return prev
        const { [columnName]: _dropped, ...rest } = prev
        return rest
      })
      // No success toast — the column disappears from the grid immediately.
    } catch (error: any) {
      console.error('Delete column error:', error)
      // Surface the server's specific message — e.g. the 400 that blocks deleting
      // a webhook's marker column ("Delete the webhook first..."), or an
      // active-run 409 — instead of a generic, unactionable "Failed to delete".
      toast.error(error?.response?.data?.error || 'Failed to delete column')
    }
  }, [activeSheet, setSheetData, setEmptyFilter, setColumnFilters, dropPendingForColumn, waitForSaves])

  // Drag-reorder: optimistic, serialized, latest-drag rollback.
  const { handleColumnReorder } = useColumnReorder({ activeSheet, sheetData, columnOrder, setColumnOrder })

  // Optimistic rename extracted to its own hook (keeps this file under the line cap).
  const { handleRenameColumn } = useColumnRename({
    activeSheet, sheetData, columnOrder,
    setSheetData, setColumnOrder, setEmptyFilter, setColumnFilters, setLastRenamedColumn,
    waitForSaves, renamePendingColumn, setAutosavePaused,
  })

  // Memoized so SheetPage re-renders that don't change column data don't allocate a new
  // array — otherwise downstream effects (notably AGGridSpreadsheet's column-state sync)
  // see ref changes on every render and trigger a column repaint flicker.
  const columnHeaders = useMemo(() => {
    if (!sheetData?.data.columns) return []
    if (columnOrder.length > 0) {
      const seen = new Set<string>()
      const ordered: string[] = []
      for (const col of columnOrder) {
        if (sheetData.data.columns.includes(col) && !seen.has(col)) {
          seen.add(col)
          ordered.push(col)
        }
      }
      const missing = sheetData.data.columns.filter(col => !seen.has(col))
      return [...ordered, ...missing.sort()]
    }
    return [...new Set(sheetData.data.columns)].sort()
  }, [sheetData?.data.columns, columnOrder])

  return {
    columnOrder,
    setColumnOrder,
    lastRenamedColumn,
    columnHeaders,
    handleAddColumn,
    handleColumnDelete,
    handleColumnReorder,
    handleRenameColumn,
  }
}
