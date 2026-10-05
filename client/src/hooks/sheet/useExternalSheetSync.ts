import { useCallback, useRef } from 'react'
import toast from 'react-hot-toast'
import { tablesAPI, Sheet, Table } from '@/utils/api'

// A sheet created, renamed, reordered or deleted somewhere else (the API, MCP,
// another tab), as reported by the change-poll: re-read the table and adopt
// its name and tab list. If the open sheet is gone, say so and move to its
// neighbour (the same pick as a local delete); if the table is gone, leave.
export function useExternalSheetSync(args: {
  table: Table | null
  setTable: React.Dispatch<React.SetStateAction<Table | null>>
  activeSheet: Sheet | null
  setActiveSheet: (s: Sheet | null) => void
  selectSheet: (s: Sheet) => Promise<void>
  dropAllPending: (sheetId: string) => void
  onTableGone: () => void
}) {
  const live = useRef(args)
  live.current = args
  const busyRef = useRef(false)
  // A change reported while a refresh is in flight: that refresh may have read
  // the table before it, so run once more when it settles.
  const againRef = useRef(false)

  const sync = useCallback(async (): Promise<void> => {
    const tableId = live.current.table?.id
    if (!tableId) return
    if (busyRef.current) { againRef.current = true; return }
    busyRef.current = true
    againRef.current = false
    try {
      const fresh = await tablesAPI.getById(tableId)
      const { table, setTable, activeSheet, setActiveSheet, selectSheet, dropAllPending } = live.current
      if (table?.id !== tableId) return // navigated to another table meanwhile
      const sheets = fresh.sheets ?? []
      setTable(prev => (prev?.id === tableId
        ? { ...prev, name: fresh.name, sheets, sheets_key: fresh.sheets_key }
        : prev))
      if (!activeSheet) return
      const still = sheets.find(s => s.id === activeSheet.id)
      if (still) {
        if (still.name !== activeSheet.name) setActiveSheet(still)
        return
      }
      // Its edits can't be saved anywhere now; drop them so the switch's
      // save barrier doesn't wait on a sheet that no longer exists.
      dropAllPending(activeSheet.id)
      toast.error(`The sheet "${activeSheet.name}" was deleted somewhere else.`)
      const idx = (table.sheets ?? []).findIndex(s => s.id === activeSheet.id)
      const survivor = sheets[idx] ?? sheets[idx - 1] ?? sheets[0]
      if (survivor) await selectSheet(survivor)
    } catch (err: any) {
      if (err?.response?.status === 404 && live.current.table?.id === tableId) live.current.onTableGone()
    } finally {
      busyRef.current = false
      if (againRef.current) void sync()
    }
  }, [])
  return sync
}
