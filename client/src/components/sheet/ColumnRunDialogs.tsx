import React, { useEffect, useState } from 'react'
import Modal from '@/components/Modal'
import { FIRST_ROWS_DEFAULT, FIRST_ROWS_MAX } from '@/lib/constants'
import { plural } from '@/lib/utils'

// The column menu's "Run First Rows" for AI and HTTP API columns (SheetGrid):
// asks how many of the sheet's top rows to run again, a test before a big
// run. (Its other runs confirm with their estimate: RunControlConfirm.)
// columnName: the AI header clicked (a structured run reruns from any of its columns).
export interface RunAsk { kind: 'ai' | 'http'; column: string; columnName?: string }

interface Runs {
  handleRunAIFirstRows: (baseName: string, columnName: string, rows: number) => unknown
  handleRunHTTPFirstRows: (column: string, rows: number) => unknown
}

// sheetRows: the sheet's row count, so the button never offers more rows than there are.
const FirstRowsDialog: React.FC<{
  ask: RunAsk | null; sheetRows: number; onRun: (rows: number) => void; onCancel: () => void
}> = ({ ask, sheetRows, onRun, onCancel }) => {
  // As typed (a field cleared while typing stays empty); read as a whole number from 1 to FIRST_ROWS_MAX.
  const [typed, setTyped] = useState(String(FIRST_ROWS_DEFAULT))
  const valid = Number(typed) >= 1
  const rows = valid ? Math.min(FIRST_ROWS_MAX, Math.floor(Number(typed))) : 0
  // The last one asked about stays shown while the dialog fades out.
  const [shown, setShown] = useState<RunAsk | null>(ask)
  useEffect(() => { if (ask) setShown(ask) }, [ask])
  const a = ask ?? shown
  return (
    <Modal isOpen={!!ask} onClose={onCancel} panelClassName="max-w-md w-full">
      <form className="p-6 space-y-4" data-testid="first-rows-dialog"
        onSubmit={e => { e.preventDefault(); if (valid) onRun(rows) }}>
        <h3 className="text-title text-gray-900">Run the first rows</h3>
        <p className="text-sm text-gray-600">
          {a?.kind === 'ai'
            ? `Runs "${a.column}" again on the first rows of the sheet and replaces what they hold. Each row uses `
              + 'your OpenRouter credits.'
            : `Calls the API of "${a?.column ?? ''}" again for the first rows of the sheet and replaces their `
              + 'results.'}
          {' '}The rows go from the top of the sheet, whatever a filter hides. Check them, then run the rest.
        </p>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          Rows
          <input type="number" min={1} max={FIRST_ROWS_MAX} className="input w-24" value={typed} autoFocus
            aria-label="Rows to run" data-testid="first-rows-count" onChange={e => setTyped(e.target.value)} />
        </label>
        <div className="flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn-primary" data-testid="first-rows-run" disabled={!valid}>
            {valid ? `Run ${plural(sheetRows > 0 ? Math.min(rows, sheetRows) : rows, 'row')}` : 'Run'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function useColumnRunDialogs(runs: Runs, sheetRows: number) {
  const [first, setFirst] = useState<RunAsk | null>(null)
  const runFirst = async (rows: number) => {
    const c = first
    setFirst(null)
    if (c?.kind === 'ai') await runs.handleRunAIFirstRows(c.column, c.columnName ?? `${c.column} (Output)`, rows)
    else if (c) await runs.handleRunHTTPFirstRows(c.column, rows)
  }
  const dialogs = (
    <FirstRowsDialog ask={first} sheetRows={sheetRows} onRun={rows => void runFirst(rows)}
      onCancel={() => setFirst(null)} />
  )
  return { askFirstRows: setFirst, dialogs }
}
