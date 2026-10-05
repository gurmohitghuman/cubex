import React from 'react'
import { HTTPPreview } from './types'

// "List view" of the preview — same shape as the legacy PreviewStep, kept for
// users who prefer a flat checkbox list to the JSON tree (or for huge response
// payloads where the tree is unwieldy). Pulled out of ReviewStep so each file
// stays under the 200-line cap.
export function PreviewFlatList({
  previewResults, selectedFields, setSelectedFields,
}: {
  previewResults: HTTPPreview[]
  selectedFields: Set<string>
  setSelectedFields: (s: Set<string>) => void
}) {
  const allFields = new Set<string>()
  previewResults.forEach(r => {
    if (r.status === 'success' && r.extractedFields) {
      Object.keys(r.extractedFields).forEach(f => allFields.add(f))
    }
  })
  return (
    <div className="space-y-3">
      {allFields.size > 0 && (
        <div className="border border-gray-200 p-3">
          <div className="text-xs font-medium text-gray-700 mb-2">Pick fields to save as columns</div>
          <div className="grid grid-cols-2 gap-2">
            {Array.from(allFields).map(f => (
              <label key={f} className="flex items-center space-x-2 text-sm">
                <input type="checkbox" checked={selectedFields.has(f)}
                  onChange={(e) => {
                    const next = new Set(selectedFields)
                    if (e.target.checked) next.add(f); else next.delete(f)
                    setSelectedFields(next)
                  }}
                  className="border-gray-300" />
                <span className="text-gray-700">{f}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {/* The preview covers the sheet's first rows in order, so position = grid row. */}
      {previewResults.map((r, i) => (
        <div key={r.rowIndex} className="border border-gray-200 p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">Row {i + 1}</span>
            <StatusBadge status={r.status} />
          </div>
          {r.status === 'error' && r.error && <p className="text-sm text-cube-black">{r.error}</p>}
          {r.status === 'success' && Object.keys(r.extractedFields).length > 0 && (
            <div className="bg-gray-50 p-2 space-y-1">
              {Object.entries(r.extractedFields).map(([k, v]) => (
                <div key={k} className="flex items-start gap-2 text-xs">
                  <span className={`font-medium flex-shrink-0 ${selectedFields.has(k) ? 'text-gray-700' : 'text-gray-700'}`}>{k}:</span>
                  <span className="text-gray-800 font-mono break-all">
                    {v === undefined || v === null ? '<missing>' : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function StatusBadge({ status }: { status: 'success' | 'error' | 'skipped' }) {
  if (status === 'success') return <span className="text-xs bg-cube-black text-white px-2 py-1">Success</span>
  if (status === 'error') return <span className="text-xs bg-white text-cube-black border border-cube-black px-2 py-1">Error</span>
  return <span className="text-xs bg-gray-100 text-gray-700 px-2 py-1">Skipped</span>
}
