import React from 'react'
import Modal from '@/components/Modal'
import { RUN_COLUMN_KIND_LABEL, type ColumnRunMode } from '@/utils/api/column-runs'
import type { WhereItem } from '@/utils/api/views'
import { whereWords } from '@/lib/views'
import { MAX_COLUMN_RUN_COLUMNS } from '@/lib/constants'
import { useRunColumnsForm } from './useRunColumnsForm'
import { ColumnRunEstimateView } from './ColumnRunEstimateView'

const LABEL = 'block text-xs font-medium text-gray-700 mb-1'
const ROWS: Array<{ mode: ColumnRunMode; label: string; help: string }> = [
  { mode: 'empty_or_out_of_date', label: 'Empty or out of date',
    help: 'Rows not run yet, and rows whose inputs changed since.' },
  { mode: 'errored', label: 'Failed', help: 'Rows that show an error.' },
  { mode: 'all', label: 'All rows', help: 'Every row again, billed again.' },
]

interface Props {
  isOpen: boolean
  onClose: () => void
  sheetId: string
  // The sheet's filter as a where (null: none): "only rows in the current filter" is offered with it.
  filter: WhereItem[] | null
}

// Run columns: tick the sheet's AI, HTTP API, enrichment and waterfall columns, pick the rows, see the cost,
// start. Each runs with its own settings; one that reads another ticked column runs after it. How a first-time
// user does it: Data, Run columns, Start (every column is ticked, on its empty or out-of-date rows).
export const RunColumnsModal: React.FC<Props> = ({ isOpen, onClose, sheetId, filter }) => {
  const f = useRunColumnsForm({ sheetId, open: isOpen, filter, onStarted: onClose })
  const n = f.picked.length
  return (
    <Modal isOpen={isOpen} onClose={() => { if (!f.starting) onClose() }} panelClassName="max-w-2xl w-full">
      <div className="p-6 border-b border-gray-200">
        <h3 className="text-title text-gray-900">Run columns</h3>
        <p className="text-sm text-gray-600 mt-1">
          Run several columns again in one go, each with its own settings. A column that reads another one runs
          after it.
        </p>
      </div>
      <div className="p-6 space-y-5 max-h-[65vh] overflow-y-auto" data-testid="run-columns-form">
        <div>
          <span className={LABEL}>Columns</span>
          {f.loadError ? (
            <p className="text-sm text-red-600">{f.loadError}</p>
          ) : !f.columns ? (
            <p className="text-sm text-gray-500">Reading the sheet&apos;s columns…</p>
          ) : f.columns.length === 0 ? (
            <p className="text-sm text-gray-600" data-testid="run-columns-none">
              This sheet has no AI, HTTP API, enrichment or waterfall columns yet. Add one first.
            </p>
          ) : (
            <div className="border border-gray-200 divide-y divide-gray-100 max-h-56 overflow-y-auto">
              {f.columns.map(c => (
                <label key={c.column} data-testid="run-columns-option"
                  className="flex items-center gap-2.5 px-3 py-2 text-sm text-gray-800 hover:bg-gray-50 cursor-pointer">
                  <input type="checkbox" className="border-gray-300 text-cube-black focus:ring-black"
                    checked={f.picked.includes(c.column)} onChange={() => f.toggle(c.column)} aria-label={c.column}
                    disabled={!f.picked.includes(c.column) && n >= MAX_COLUMN_RUN_COLUMNS} />
                  <span className="font-medium">{c.column}</span>
                  <span className="text-xs text-gray-500">· {RUN_COLUMN_KIND_LABEL[c.kind]}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {!!f.columns?.length && (
          <>
            <fieldset>
              <legend className={LABEL}>Rows</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-1">
                {ROWS.map(r => (
                  <label key={r.mode} className="flex items-center gap-1.5 text-sm text-gray-700">
                    <input type="radio" name="run-columns-rows" value={r.mode} checked={f.mode === r.mode}
                      onChange={() => f.setMode(r.mode)} className="border-gray-300 text-cube-black focus:ring-black" />
                    {r.label}
                  </label>
                ))}
              </div>
              <p className="text-xs text-gray-500 mt-1">{ROWS.find(r => r.mode === f.mode)?.help}</p>
              {filter && (
                <label className="mt-2 flex items-start gap-2 text-sm text-gray-700">
                  <input type="checkbox" className="mt-0.5 border-gray-300 text-cube-black focus:ring-black"
                    checked={f.inFilter} onChange={e => f.setInFilter(e.target.checked)}
                    data-testid="run-columns-in-filter" />
                  <span>
                    Only rows in the current filter
                    <span className="block text-xs text-gray-500 truncate">{whereWords(filter)}</span>
                  </span>
                </label>
              )}
            </fieldset>

            {n > 0 && <ColumnRunEstimateView state={f.estimate} />}

            <label className="block">
              <span className={LABEL}>Spend at most (optional)</span>
              <span className="flex items-center gap-1.5 text-sm text-gray-700">
                $<input className="input w-28" inputMode="decimal" value={f.maxCost} placeholder="No limit"
                  onChange={e => f.setMaxCost(e.target.value)} data-testid="run-columns-max-cost" />
              </span>
              <span className="block text-xs text-gray-500 mt-1">
                {f.costOk ? 'It won\'t start if it could cost more, and stops before it would.'
                  : 'Enter a dollar amount, like 5.'}
              </span>
            </label>
          </>
        )}
      </div>
      <div className="px-6 py-4 border-t border-gray-200 flex flex-wrap items-center justify-end gap-3">
        {f.nothing && <span className="w-full sm:w-auto sm:mr-auto text-sm text-gray-600">No row needs running.</span>}
        <button type="button" className="btn-secondary" onClick={onClose} disabled={f.starting}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!f.canStart} onClick={() => void f.start()}
          data-testid="run-columns-start">
          {f.starting ? 'Starting…' : n === 1 ? 'Run 1 column' : `Run ${n} columns`}
        </button>
      </div>
    </Modal>
  )
}
