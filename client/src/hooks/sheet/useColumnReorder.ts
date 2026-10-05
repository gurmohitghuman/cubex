import { useCallback, useRef } from 'react'
import toast from 'react-hot-toast'
import { sheetsAPI, Sheet, SheetData } from '@/utils/api'

interface UseColumnReorderArgs {
  activeSheet: Sheet | null
  sheetData: SheetData | null
  // useColumnOps' live display order (the rollback target) and its setter.
  columnOrder: string[]
  setColumnOrder: React.Dispatch<React.SetStateAction<string[]>>
}

// Column drag-reorder, split out of useColumnOps like useColumnRename.
export const useColumnReorder = ({ activeSheet, sheetData, columnOrder, setColumnOrder }: UseColumnReorderArgs) => {
  // Serialize rapid column drags. Two quick drags fire two PUTs that race (the
  // server overwrites column_order wholesale, so a stale PUT can land LAST and win).
  // reorderSeqRef tags each drag (only the LATEST drag's catch rolls back);
  // reorderChainRef awaits the prior PUT so drags reach the server in order.
  const reorderSeqRef = useRef(0)
  const reorderChainRef = useRef<Promise<unknown>>(Promise.resolve())

  const handleColumnReorder = useCallback(async (newColumnOrder: string[]) => {
    if (!activeSheet) return
    // Capture the PRE-DRAG order to restore on failure. columnOrder is the live
    // display-order source of truth (updated by every reorder/rename/delete/add),
    // so it's the correct rollback target — NOT sheetData.data.columns, which
    // holds the load-time order and is never updated by a reorder. Rolling back
    // to sheetData would snap past any earlier successful reorder this session.
    // Fall back to sheetData.data.columns only if columnOrder isn't populated yet.
    const previousOrder = columnOrder.length > 0 ? columnOrder : (sheetData?.data.columns ?? [])
    // Optimistic update reflects the latest drag immediately. Tag this drag and
    // chain its PUT after any in-flight one so the server receives drags in order
    // (latest lands last → wins); a stale earlier PUT can't overwrite a newer one.
    setColumnOrder(newColumnOrder)
    const seq = ++reorderSeqRef.current
    const send = reorderChainRef.current.then(async () => {
      try {
        await sheetsAPI.reorderColumns(activeSheet.id, newColumnOrder)
        // No success toast — the new order is what the user is already looking at.
      } catch (error: any) {
        console.error('Failed to reorder columns:', error)
        // Only the LATEST drag rolls back. A stale drag's failure must not clobber
        // a newer drag the user has since made (and which is the current display).
        if (seq === reorderSeqRef.current) {
          toast.error('Failed to reorder columns')
          setColumnOrder(previousOrder)
        }
      }
    })
    // Keep the chain alive even if this link rejected (it can't — caught above),
    // so the next drag still serializes behind it.
    reorderChainRef.current = send.catch(() => {})
    return send
  }, [activeSheet, columnOrder, sheetData])

  return { handleColumnReorder }
}
