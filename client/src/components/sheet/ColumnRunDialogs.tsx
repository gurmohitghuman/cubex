import React, { useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import Modal from '@/components/Modal'
import { FIRST_ROWS_DEFAULT, FIRST_ROWS_MAX } from '@/lib/constants'
import { plural } from '@/lib/utils'

// The column menu's run confirms for AI and HTTP API columns (SheetGrid):
// "Run All Rows" asks first, as it spends credits or requests on every row
// again; "Run First Rows" asks how many of the sheet's top rows to run again,
// a test before a big run. columnName: the AI header clicked (a structured run
// reruns from any of its columns).
export interface RunAsk { kind: 'ai' | 'http'; column: string; columnName?: string }

interface Runs {
  handleRunAIForColumn: (baseName: string, columnName?: string) => unknown
  handleRunHTTPForColumn: (column: string) => unknown
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
  const [runAll, setRunAll] = useState<RunAsk | null>(null)
  const [first, setFirst] = useState<RunAsk | null>(null)
  const confirmAll = async () => {
    const c = runAll
    setRunAll(null)
    if (c?.kind === 'ai') await runs.handleRunAIForColumn(c.column, c.columnName)
    else if (c) await runs.handleRunHTTPForColumn(c.column)
  }
  const runFirst = async (rows: number) => {
    const c = first
    setFirst(null)
    if (c?.kind === 'ai') await runs.handleRunAIFirstRows(c.column, c.columnName ?? `${c.column} (Output)`, rows)
    else if (c) await runs.handleRunHTTPFirstRows(c.column, rows)
  }
  const dialogs = (
    <>
      <ConfirmDialog
        isOpen={!!runAll}
        title="Run all rows again?"
        message={runAll?.kind === 'ai'
          ? `"${runAll.column}" will be cleared and filled again on every row, using your OpenRouter credits. `
            + 'To fill only empty or failed rows, use "Run Missing or Errors" instead.'
          : `"${runAll?.column ?? ''}" will call the API again for every row and replace the current results.`}
        confirmText="Run all rows"
        onConfirm={confirmAll}
        onCancel={() => setRunAll(null)}
      />
      <FirstRowsDialog ask={first} sheetRows={sheetRows} onRun={rows => void runFirst(rows)}
        onCancel={() => setFirst(null)} />
    </>
  )
  return { askRunAll: setRunAll, askFirstRows: setFirst, dialogs }
}
