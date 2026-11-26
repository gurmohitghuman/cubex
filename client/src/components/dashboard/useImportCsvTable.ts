import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { sheetsAPI, tablesAPI } from '@/utils/api'
import { plural } from '@/lib/utils'
import { toastImportGarbled } from '@/components/sheet/importGarbledToast'

// The server's longest table name (server/src/lib/constants.ts MAX_TABLE_NAME_LENGTH).
const MAX_NAME = 100

// "leads_2026.csv" makes the table "leads_2026", without the characters a table name can't have (< > ").
export const tableNameOf = (file: string): string =>
  file.replace(/\.csv$/i, '').replace(/[<>"]/g, '').trim().slice(0, MAX_NAME).trim() || 'Imported table'

// The name, or the first of "name (2)", "name (3)"... that no table has (names are unique whatever their case), as
// the sample and the ready-made tables pick theirs.
export function freeTableName(name: string, taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const end = n === 1 ? '' : ` (${n})`
    const candidate = name.slice(0, MAX_NAME - end.length).trim() + end
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

// The home's Import CSV: a new table named after the file, the file imported into its first sheet as that sheet's
// own Import CSV does (a new sheet's blank rows give way to the file's), then the table opens. When the import fails
// the table stays, empty, and opens all the same: the toast says why, and its sheet's Import CSV tries again. A name
// already taken (another table, or one made meanwhile in another tab) gets the next free "name (2)". An import that
// finishes after the person left the home doesn't take them away from where they went: the toast says where it is.
export function useImportCsvTable(tableNames: string[]) {
  const navigate = useNavigate()
  const [importing, setImporting] = useState<string | null>(null)
  const shown = useRef(true)
  useEffect(() => { shown.current = true; return () => { shown.current = false } }, [])
  const names = useRef(tableNames)
  names.current = tableNames

  const importFile = useCallback(async (file: File) => {
    // The extension, as the sheet's import and the server check it (a browser's MIME type for .csv varies).
    if (!file.name.toLowerCase().endsWith('.csv')) { toast.error('Please select a CSV file'); return }
    setImporting(file.name)
    const note = toast.loading(`Importing ${file.name}…`)
    try {
      const taken = new Set(names.current.map(n => n.toLowerCase()))
      const base = tableNameOf(file.name)
      let table
      for (let tries = 0; !table; tries++) {
        const name = freeTableName(base, taken)
        try { table = await tablesAPI.create(name) } catch (e: any) {
          // Taken meanwhile (another tab): the next free name, a few times at most.
          if (e?.response?.status === 409 && tries < 5) { taken.add(name.toLowerCase()); continue }
          toast.error(e?.response?.data?.error || 'Failed to create the table', { id: note })
          return
        }
      }
      const sheetId = table.sheets?.[0]?.id
      try {
        if (!sheetId) throw new Error('no sheet')
        const r = await sheetsAPI.importCSV(sheetId, file)
        const where = shown.current ? '' : ' Open it from Tables.'
        toast.success(`${plural(r.rowsImported, 'row')} imported into "${table.name}".${where}`, { id: note })
        if ((r.garbledCells ?? 0) > 0) toastImportGarbled(r.garbledCells!, r.garbledSamples ?? {})
      } catch (e: any) {
        toast.error(`${e?.response?.data?.error || 'Failed to import CSV'} The table "${table.name}" is there, `
          + 'empty: its sheet\'s Import CSV tries again.', { id: note })
      }
      if (shown.current) navigate(sheetId ? `/table/${table.id}/${sheetId}` : `/table/${table.id}`)
    } finally {
      setImporting(null)
    }
  }, [navigate])

  return { importFile, importing }
}
