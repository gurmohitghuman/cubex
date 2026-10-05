import { useCallback, useRef } from 'react'
import toast from 'react-hot-toast'
import { sheetsAPI, Sheet, Table } from '@/utils/api'

interface UseSheetRenameArgs {
  table: Table | null
  setTable: React.Dispatch<React.SetStateAction<Table | null>>
  activeSheetRef: React.MutableRefObject<Sheet | null>
  setActiveSheet: (s: Sheet | null) => void
  tableIdRef: React.MutableRefObject<string | null>
  reconcileSheets: (sheets: Sheet[]) => void
  beginOp: () => void
  endOp: () => void
}

// Optimistic sheet rename — extracted from useSheetOps to keep both under the 200-line
// cap (mirrors how useColumnRename was split out of useColumnOps). Unlike column rename,
// there is NO autosave-queue remap and NO pause: the queue is stamped with the stable
// sheetId, not the name. PATCHes for the same sheet are serialized (renameChainRef) so
// the SERVER applies them in order; a per-sheet seq gates the optimistic rollback so an
// older failure can't clobber a newer rename's value. Cross-op correctness comes from
// useSheetOps' begin/end settle-refetch (server always authoritative).
export const useSheetRename = ({
  table, setTable, activeSheetRef, setActiveSheet, tableIdRef, reconcileSheets, beginOp, endOp,
}: UseSheetRenameArgs) => {
  const renameSeqRef = useRef<Map<string, number>>(new Map())
  const renameChainRef = useRef<Map<string, Promise<void>>>(new Map())

  const renameSheet = useCallback((sheetId: string, rawName: string) => {
    const tableId = table?.id
    if (!tableId) return
    const sheets = table?.sheets ?? []
    const name = rawName.trim()
    if (!name) return
    const target = sheets.find(s => s.id === sheetId)
    if (!target || name === target.name) return
    if (sheets.some(s => s.id !== sheetId && s.name.toLowerCase() === name.toLowerCase())) {
      toast.error(`A sheet named "${name}" already exists`)
      return
    }
    const prevName = target.name
    const seq = (renameSeqRef.current.get(sheetId) ?? 0) + 1
    renameSeqRef.current.set(sheetId, seq)
    const boundTableId = tableId

    const applyName = (nm: string) => {
      setTable(prev => prev
        ? { ...prev, sheets: (prev.sheets ?? []).map(s => (s.id === sheetId ? { ...s, name: nm } : s)) }
        : prev)
      if (activeSheetRef.current?.id === sheetId) {
        setActiveSheet({ ...activeSheetRef.current, name: nm } as Sheet)
      }
    }
    applyName(name) // optimistic flip

    // Serialize per-sheet so the server applies renames in order (A→B then A→C ends at C).
    const prior = renameChainRef.current.get(sheetId) ?? Promise.resolve()
    beginOp()
    const send = prior.then(async () => {
      try {
        const res = await sheetsAPI.renameSheet(boundTableId, sheetId, name)
        if (tableIdRef.current === boundTableId) reconcileSheets(res.sheets)
      } catch (err: any) {
        if (tableIdRef.current !== boundTableId) return
        // Only the latest rename for this sheet rolls back its optimistic name.
        if (renameSeqRef.current.get(sheetId) === seq) applyName(prevName)
        toast.error(err?.response?.data?.error || 'Failed to rename sheet')
      } finally { endOp() }
    })
    renameChainRef.current.set(sheetId, send.catch(() => {}))
  }, [table, setTable, activeSheetRef, setActiveSheet, tableIdRef, reconcileSheets, beginOp, endOp])

  return { renameSheet }
}
