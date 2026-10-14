import React from 'react'
import { Loader2 } from 'lucide-react'
import type { CleanPreviewState } from './useCleanPreview'

interface Props {
  state: CleanPreviewState
  // A source and a cleaner are picked (else there's nothing to preview).
  ready: boolean
}

const LABEL = 'block text-xs font-medium text-gray-700'

// The first rows of the source column, before and after cleaning. Values are
// cell data: rendered as text only.
export const CleanPreview: React.FC<Props> = ({ state, ready }) => {
  const { loading, result, error } = state
  let body: React.ReactNode
  if (!ready) body = <p className="text-xs text-gray-500">Pick a column and a cleaner to see a preview.</p>
  else if (error) body = <p className="text-xs text-red-600" data-testid="clean-preview-error">{error}</p>
  else if (!result) body = <p className="text-xs text-gray-500">Loading the preview…</p>
  else if (result.samples.length === 0) body = <p className="text-xs text-gray-500">No values in this column yet</p>
  else {
    body = (
      // While the next preview loads, the last one stays, dimmed (it may be for another column).
      <table className={`w-full table-fixed text-xs border border-gray-200 ${loading ? 'opacity-40' : ''}`}>
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            <th className="w-1/2 text-left font-medium px-2 py-1">Before</th>
            <th className="text-left font-medium px-2 py-1">→ After</th>
          </tr>
        </thead>
        <tbody>
          {result.samples.map(s => (
            <tr key={s.row} className="border-t border-gray-100">
              <td className="px-2 py-1 text-gray-600 truncate" title={s.before}>{s.before}</td>
              <td className="px-2 py-1 text-gray-900 truncate" title={s.after}>
                {s.after || <span className="italic text-gray-400">blank</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  return (
    <div data-testid="clean-preview">
      <div className="flex items-center gap-1.5 mb-1">
        <span className={LABEL}>Preview</span>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-gray-400" aria-label="Loading the preview" />}
      </div>
      {body}
    </div>
  )
}
