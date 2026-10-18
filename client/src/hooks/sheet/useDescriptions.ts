import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import toast from 'react-hot-toast'
import { descriptionsAPI, type Sheet, type SheetData, type Table } from '@/utils/api'

export type DescriptionTarget = { kind: 'column'; column: string; sheetId: string } | { kind: 'sheet'; sheet: Sheet }

interface Args {
  activeSheet: Sheet | null
  sheetData: SheetData | null
  setSheetData: Dispatch<SetStateAction<SheetData | null>>
  setTable: Dispatch<SetStateAction<Table | null>>
}

// The column menu's and the sheet tab menu's "Edit description": which one the
// dialog is open on, its text now, and saving it. A save shows at once in the
// header note or the tab (the server's cleaned text). A column's dialog keeps
// the sheet it was opened on, and closes if another sheet shows meanwhile (its
// sheet deleted elsewhere): it never saves onto a same-named column there.
export function useDescriptions({ activeSheet, sheetData, setSheetData, setTable }: Args) {
  const [target, setTarget] = useState<DescriptionTarget | null>(null)
  const activeId = activeSheet?.id
  const openColumn = useCallback((column: string) => {
    if (activeId) setTarget({ kind: 'column', column, sheetId: activeId })
  }, [activeId])
  const openSheet = useCallback((sheet: Sheet) => setTarget({ kind: 'sheet', sheet }), [])
  const close = useCallback(() => setTarget(null), [])
  useEffect(() => {
    if (target?.kind === 'column' && target.sheetId !== activeId) setTarget(null)
  }, [target, activeId])

  const initial = !target ? ''
    : target.kind === 'column'
      ? (sheetData?.sheet.id === target.sheetId ? sheetData.data.columnDescriptions?.[target.column] ?? '' : '')
    : target.sheet.description ?? ''

  const save = useCallback(async (text: string): Promise<boolean> => {
    if (!target) return false
    try {
      if (target.kind === 'sheet') {
        const sheetId = target.sheet.id
        const { description } = await descriptionsAPI.saveSheet(sheetId, text)
        setTable(prev => (prev ? {
          ...prev, sheets: prev.sheets?.map(s => (s.id === sheetId ? { ...s, description } : s)),
        } : prev))
        setSheetData(prev => (prev?.sheet.id === sheetId ? { ...prev, sheet: { ...prev.sheet, description } } : prev))
        return true
      }
      const { column, sheetId } = target
      const { description } = await descriptionsAPI.saveColumn(sheetId, column, text)
      setSheetData(prev => {
        if (!prev || prev.sheet.id !== sheetId) return prev
        const { [column]: _old, ...rest } = prev.data.columnDescriptions ?? {}
        const columnDescriptions = description ? { ...rest, [column]: description } : rest
        return { ...prev, data: { ...prev.data, columnDescriptions } }
      })
      return true
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Could not save the description')
      return false
    }
  }, [target, setSheetData, setTable])

  return { target, initial, openColumn, openSheet, close, save }
}
