import React, { useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { Loader2, Upload } from 'lucide-react'
import { sheetsAPI, type ImportAutoDedupe } from '@/utils/api'
import { ImportFileCard } from './import-csv/ImportFileCard'
import { ImportAutorunNotice } from './import-csv/ImportAutorunNotice'

interface ImportCSVModalProps {
  isOpen: boolean
  onClose: () => void
  sheetId: string | undefined
  onImported: (result: { rowsImported: number; newColumns: string[]; autoDedupe: ImportAutoDedupe | null }) => void
  // Run BEFORE the import POST (which replaces rows + bumps row_generation).
  // Returns false to abort — e.g. pending autosaves couldn't be drained, so
  // letting a CSV-replace proceed would flush a straggler edit onto the wrong
  // row after reload. Same barrier sort/delete/rename use. Optional so the modal
  // works standalone (tests, future call sites) without a barrier.
  onBeforeImport?: () => Promise<boolean>
  // A column of this sheet has auto-run on: the imported rows are new rows it fills.
  autorunOn?: boolean
}

export const ImportCSVModal: React.FC<ImportCSVModalProps> = ({
  isOpen,
  onClose,
  sheetId,
  onImported,
  onBeforeImport,
  autorunOn,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [replaceData, setReplaceData] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [pauseAutorun, setPauseAutorun] = useState(false)
  // The auto-run notice is still working out what the rows set off: the import waits for it.
  const [noticeReady, setNoticeReady] = useState(true)

  if (!isOpen) return null

  const reset = () => {
    setSelectedFile(null)
    setUploadProgress(0)
    setPauseAutorun(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // Extension check, NOT MIME type — matching the server (sheets-shared.ts).
    // Browsers report whatever the OS associates with .csv: Windows with
    // Excel installed says 'application/vnd.ms-excel', some report '' — a
    // strict 'text/csv' check rejected valid files for those users.
    if (file && file.name.toLowerCase().endsWith('.csv')) setSelectedFile(file)
    else toast.error('Please select a CSV file')
  }

  const handleImport = async () => {
    if (!sheetId || !selectedFile) return
    setIsImporting(true)
    setUploadProgress(0)
    // Drain + discard pending edits BEFORE the server replaces data. After a
    // CSV-replace, an edit's (rowIndex, columnName) addresses a different logical
    // row, so a late flush would corrupt the wrong cell. If the barrier can't
    // complete (saves stuck), abort rather than risk that. Runs before importCSV
    // so the window between POST-complete and reload can't leak a flush.
    if (onBeforeImport) {
      const ok = await onBeforeImport()
      if (!ok) {
        setIsImporting(false)
        toast.error("Couldn't save your pending edits; import cancelled. Check your connection and try again.")
        return
      }
    }
    // Declared outside try and cleared in finally: previously only the
    // success path cleared it, so a failed import left the interval ticking
    // setUploadProgress every 200ms forever (and a retry ran two at once).
    const progressInterval = setInterval(() => {
      setUploadProgress(prev => (prev >= 90 ? prev : prev + Math.random() * 20))
    }, 200)
    try {
      const result = await sheetsAPI.importCSV(sheetId, selectedFile, replaceData, !!autorunOn && pauseAutorun)
      setUploadProgress(100)

      setTimeout(() => {
        onImported({
          rowsImported: result.rowsImported, newColumns: result.newColumns ?? [], autoDedupe: result.autoDedupe ?? null,
        })
        reset()
        onClose()
      }, 500)
    } catch (error: any) {
      setUploadProgress(0)
      toast.error(error.response?.data?.error || 'Failed to import CSV')
    } finally {
      clearInterval(progressInterval)
      setIsImporting(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={() => !isImporting && onClose()}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="p-6 border-b border-gray-200">
          <h3 className="text-title text-gray-900">Import CSV</h3>
          <p className="text-sm text-gray-600 mt-1">
            Upload a CSV file to import data into this sheet
          </p>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="flex items-center space-x-2 text-sm">
              <input
                type="checkbox"
                checked={replaceData}
                onChange={(e) => setReplaceData(e.target.checked)}
                className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                disabled={isImporting}
              />
              <span>Replace existing data</span>
            </label>
            <p className="text-xs text-gray-500 mt-1">
              {replaceData ? 'The rows there now go to the trash, where you can restore them'
                : 'New data will be appended'}
            </p>
          </div>

          {!selectedFile ? (
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleFileSelect}
                className="hidden"
                disabled={isImporting}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isImporting}
                className={'w-full btn-secondary flex items-center justify-center space-x-2 py-8 border-2'
                  + ' border-dashed border-gray-300 hover:border-gray-400'
                  + ' disabled:opacity-50 disabled:cursor-not-allowed'}
              >
                <Upload className="h-6 w-6" />
                <span>Choose CSV File</span>
              </button>
            </div>
          ) : (
            <ImportFileCard file={selectedFile} importing={isImporting} progress={uploadProgress} onRemove={reset} />
          )}

          {selectedFile && autorunOn && sheetId && (
            <ImportAutorunNotice sheetId={sheetId} file={selectedFile} paused={pauseAutorun}
              onPausedChange={setPauseAutorun} disabled={isImporting} onReady={setNoticeReady} />
          )}

          <div className="flex justify-end space-x-3">
            <button
              type="button"
              onClick={() => { reset(); onClose() }}
              disabled={isImporting}
              className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            {selectedFile && (
              <button
                onClick={handleImport}
                disabled={isImporting || (!!autorunOn && !noticeReady)}
                className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
              >
                {isImporting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Uploading…</span>
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4" />
                    <span>Upload CSV</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
