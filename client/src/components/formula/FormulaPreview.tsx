import React from 'react'
import { Loader2 } from 'lucide-react'
import type { FormulaPreviewState } from './useFormulaPreview'

interface Props {
  state: FormulaPreviewState
  // A formula is written (else there's nothing to preview).
  ready: boolean
}

const LABEL = 'block text-xs font-medium text-gray-700'

// What the formula gives on the first rows that hold a value: the cells it
// reads, and the result or the row's error. Values are cell data: rendered
// as text only.
export const FormulaPreview: React.FC<Props> = ({ state, ready }) => {
  const { loading, result, error } = state
  let body: React.ReactNode
  if (!ready) body = <p className="text-xs text-gray-500">Write a formula to see what it gives on the first rows.</p>
  else if (error) body = <p className="text-xs text-red-600" data-testid="formula-preview-error">{error}</p>
  else if (!result) body = <p className="text-xs text-gray-500">Loading the preview…</p>
  else if (result.samples.length === 0) {
    body = <p className="text-xs text-gray-500">No values yet in the columns it reads</p>
  } else {
    body = (
      // While the next preview loads, the last one stays, dimmed.
      <table className={`w-full table-fixed text-xs border border-gray-200 ${loading ? 'opacity-40' : ''}`}>
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            <th className="w-1/2 text-left font-medium px-2 py-1">Reads</th>
            <th className="text-left font-medium px-2 py-1">→ Result</th>
          </tr>
        </thead>
        <tbody>
          {result.samples.map(s => {
            const reads = Object.entries(s.inputs).map(([c, v]) => `${c}: ${v}`).join('  ·  ')
            return (
              <tr key={s.row} className="border-t border-gray-100">
                <td className="px-2 py-1 text-gray-600 truncate" title={reads}>{reads || '(reads no column)'}</td>
                <td className={`px-2 py-1 truncate ${s.error ? 'text-red-600' : 'text-gray-900'}`}
                  title={s.error ?? s.result}>
                  {s.error ? s.result : s.result || <span className="italic text-gray-400">empty</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    )
  }
  return (
    <div data-testid="formula-preview">
      <div className="flex items-center gap-1.5 mb-1">
        <span className={LABEL}>Preview</span>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-gray-400" aria-label="Loading the preview" />}
      </div>
      {body}
      {result?.stopped && <p className="text-xs text-amber-700 mt-1">{result.stopped}</p>}
    </div>
  )
}
