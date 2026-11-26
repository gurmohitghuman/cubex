import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { sheetsAPI, tablesAPI } from '@/utils/api'
import { plural } from '@/lib/utils'
import { toastImportGarbled } from '@/components/sheet/importGarbledToast'

// The server's longest table name (server/src/lib/constants.ts MAX_TABLE_NAME_LENGTH).
const MAX_NAME = 100

// "leads_2026.csv" makes the table "leads_2026".
export const tableNameOf = (file: string): string =>
  file.replace(/\.csv$/i, '').trim().slice(0, MAX_NAME).trim() || 'Imported table'

// The home's Import CSV: a new table named after the file, the file imported into its first sheet as that sheet's
// own Import CSV does (a new sheet's blank rows give way to the file's), then the table opens. When the import fails
// the table stays, empty, and opens all the same: the toast says why, and its sheet's Import CSV tries again.
export function useImportCsvTable() {
  const navigate = useNavigate()
  const [importing, setImporting] = useState<string | null>(null)

  const importFile = useCallback(async (file: File) => {
    // The extension, as the sheet's import and the server check it (a browser's MIME type for .csv varies).
    if (!file.name.toLowerCase().endsWith('.csv')) { toast.error('Please select a CSV file'); return }
    setImporting(file.name)
    const shown = toast.loading(`Importing ${file.name}…`)
    try {
      let table
      try { table = await tablesAPI.create(tableNameOf(file.name)) } catch (e: any) {
        toast.error(e?.response?.data?.error || 'Failed to create the table', { id: shown })
        return
      }
      const sheetId = table.sheets?.[0]?.id
      try {
        if (!sheetId) throw new Error('no sheet')
        const r = await sheetsAPI.importCSV(sheetId, file)
        toast.success(`${plural(r.rowsImported, 'row')} imported into "${table.name}".`, { id: shown })
        if ((r.garbledCells ?? 0) > 0) toastImportGarbled(r.garbledCells!, r.garbledSamples ?? {})
      } catch (e: any) {
        toast.error(`${e?.response?.data?.error || 'Failed to import CSV'} The table "${table.name}" is there, `
          + 'empty: its sheet\'s Import CSV tries again.', { id: shown })
      }
      navigate(sheetId ? `/table/${table.id}/${sheetId}` : `/table/${table.id}`)
    } finally {
      setImporting(null)
    }
  }, [navigate])

  return { importFile, importing }
}
