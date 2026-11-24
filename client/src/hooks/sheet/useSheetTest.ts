import { useCallback, useState } from 'react'
import toast from 'react-hot-toast'
import { tablesAPI, type Sheet, type SheetData, type Table } from '@/utils/api'
import type { TestEntry } from '@/components/sheet/toolbar/SheetMoreMenu'
import { sheetTestAPI, type ApplyTestAnswer, type SheetTestView } from '@/utils/api/sheet-test'
import { SHEET_TEST_MAX_ROWS, SHEET_TEST_ROWS } from '@/lib/constants'
import { sheetsOf } from './useTableRouting'

interface Args {
  table: Table | null
  setTable: (t: Table | null) => void
  activeSheet: Sheet | null
  selectSheet: (s: Sheet) => Promise<void> | void
  // The rows selected in the grid, by place: a test takes them instead of the top rows.
  selectedRowIndices: number[]
  reload: (sheetId: string) => void
  sheetData: SheetData | null
}

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback

// Trying column changes on sample rows (utils/api/sheet-test.ts): start one from the sheet (its copy opens), add
// rows to it, apply it or discard it (the sheet opens again). The table is read again each time: the copy is
// opened by id and isn't a tab.
export function useSheetTest(a: Args) {
  const { table, setTable, activeSheet, selectSheet, selectedRowIndices, reload, sheetData } = a
  const [busy, setBusy] = useState(false)

  const open = useCallback(async (sheetId: string) => {
    if (!table) return
    const fresh = await tablesAPI.getById(table.id)
    setTable(fresh)
    const target = sheetsOf(fresh).find(s => s.id === sheetId)
    if (target) await selectSheet(target)
  }, [table, setTable, selectSheet])

  const start = useCallback(async () => {
    if (!activeSheet || busy) return
    const picked = selectedRowIndices.slice(0, SHEET_TEST_MAX_ROWS)
    const id = toast.loading('Making a test copy…')
    setBusy(true)
    try {
      const test = await sheetTestAPI.start(activeSheet.id, picked.length ? picked : undefined)
      await open(test.test_sheet_id)
      toast.success(`Test copy ready with ${test.rows} sample rows. Change and run columns here, then apply.`, { id })
    } catch (e) {
      toast.error(errorOf(e, 'Couldn\'t start the test. Try again.'), { id })
    } finally {
      setBusy(false)
    }
  }, [activeSheet, busy, selectedRowIndices, open])

  const addRows = useCallback(async (test: SheetTestView, how: 'top' | 'random') => {
    try {
      const out = await sheetTestAPI.addRows(test.test_sheet_id, how)
      toast.success(out.added ? `Added ${out.added} rows to the test.` : 'No more rows to add.')
      reload(test.test_sheet_id)
    } catch (e) {
      toast.error(errorOf(e, 'Couldn\'t add rows. Try again.'))
    }
  }, [reload])

  const discard = useCallback(async (test: SheetTestView) => {
    try {
      await sheetTestAPI.discard(test.sheet_id)
      toast.success(`Test discarded: ${test.sheet_name} is as it was.`)
      await open(test.sheet_id)
    } catch (e) {
      toast.error(errorOf(e, 'Couldn\'t discard the test. Try again.'))
    }
  }, [open])

  const applied = useCallback(async (answer: ApplyTestAnswer) => {
    toast.success(answer.message)
    await open(answer.test.sheet_id)
  }, [open])

  // The ⋯ menu's entry: none on a copy; off while a test of the sheet is open or it has no rows.
  const selected = selectedRowIndices.length
  const entry: TestEntry | undefined = activeSheet && !activeSheet.test_of ? {
    onStart: () => { void start() },
    disabled: busy || !!sheetData?.data.test || !sheetData?.data.rows.length,
    hint: sheetData?.data.test ? 'A test of this sheet is open'
      : selected ? `On the ${Math.min(selected, SHEET_TEST_MAX_ROWS)} rows selected: change and run columns on a copy`
        : `On the first ${SHEET_TEST_ROWS} rows: change and run columns on a copy, then apply`,
  } : undefined

  return { start, busy, addRows, discard, applied, open, entry }
}

export type SheetTestControls = ReturnType<typeof useSheetTest>
