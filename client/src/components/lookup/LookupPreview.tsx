import React from 'react'
import { Loader2 } from 'lucide-react'
import type { LookupPreviewState } from './useLookupPreview'

interface Props {
  state: LookupPreviewState
  // The lookup is set up enough to preview.
  ready: boolean
}

const LABEL = 'block text-xs font-medium text-gray-700'

// What the lookup gives on the first rows that hold a value: this row's value
// and the result (or why it can't answer). Values are cell data: text only.
export const LookupPreview: React.FC<Props> = ({ state, ready }) => {
  const { loading, result, error } = state
  let body: React.ReactNode
  if (!ready) body = <p className="text-xs text-gray-500">Pick the columns to see what it finds on the first rows.</p>
  else if (error) body = <p className="text-xs text-red-600" data-testid="lookup-preview-error">{error}</p>
  else if (!result) body = <p className="text-xs text-gray-500">Loading the preview…</p>
  else if (result.samples.length === 0) body = <p className="text-xs text-gray-500">No values yet in that column</p>
  else {
    body = (
      <table className={`w-full table-fixed text-xs border border-gray-200 ${loading ? 'opacity-40' : ''}`}>
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            <th className="w-2/5 text-left font-medium px-2 py-1">This row</th>
            <th className="text-left font-medium px-2 py-1">→ Result</th>
          </tr>
        </thead>
        <tbody>
          {result.samples.map(s => (
            <tr key={s.row} className="border-t border-gray-100">
              <td className="px-2 py-1 text-gray-600 truncate" title={s.value}>{s.value}</td>
              <td className={`px-2 py-1 truncate ${s.error ? 'text-red-600' : 'text-gray-900'}`}
                title={s.error ?? s.result}>
                {s.result || <span className="italic text-gray-400">no match</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  return (
    <div data-testid="lookup-preview">
      <div className="flex items-center gap-1.5 mb-1">
        <span className={LABEL}>Preview</span>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-gray-400" aria-label="Loading the preview" />}
      </div>
      {body}
      {result && result.checkedRows !== null && result.checkedRows < result.otherRows && (
        <p className="text-xs text-gray-500 mt-1" data-testid="lookup-preview-partial">
          The preview checked the first {result.checkedRows.toLocaleString()} of{' '}
          {result.otherRows.toLocaleString()} rows of {result.otherSheet}. The lookup itself checks every row.
        </p>
      )}
    </div>
  )
}
