import React, { useState } from 'react'
import { CheckCircle, Loader2, Play, X } from 'lucide-react'
import { HTTPAPIConfig, HTTPPreview } from './types'
import { JsonTree } from '../json-mapping/JsonTree'
import { PreviewFlatList } from './PreviewFlatList'
import { PreviewErrorTroubleshoot } from './PreviewErrorTroubleshoot'

interface Props {
  sheetId: string
  previewResults: HTTPPreview[]
  config: HTTPAPIConfig
  updateConfig: (updates: Partial<HTTPAPIConfig>) => void
  selectedFields: Set<string>
  setSelectedFields: (s: Set<string>) => void
  isCommittingPreview: boolean
  onBack: () => void
  onCommit: () => Promise<unknown>
  onStartRun: () => Promise<unknown>
  // Called after AI troubleshoot proposes a corrected config and the user
  // accepts. Parent merges into state and re-runs preview.
  onApplyAIFix: (next: HTTPAPIConfig) => Promise<void> | void
}

// ReviewStep renders the raw API response for the first successful preview row
// as a clickable JSON tree. Clicking a leaf opens an inline "Name this column"
// input; on submit, we add a {jsonPath, columnName} entry to config.responseMapping
// and tick the column on in selectedFields. Once added, the leaf shows the column
// name and an unselect button.
//
// The user can also flip to "List view" — the existing flat-checkbox UI — for
// users who prefer it or for huge responses where the tree is unwieldy.
export const ReviewStep: React.FC<Props> = ({
  sheetId, previewResults, config, updateConfig, selectedFields, setSelectedFields,
  isCommittingPreview, onBack, onCommit, onStartRun, onApplyAIFix,
}) => {
  const [view, setView] = useState<'tree' | 'list'>('tree')
  // Bumping `expandSignal` forces every JsonTree node to snap to forceOpenState.
  // Default-expand goes 3 levels (set in JsonTree.useState); deeper nesting
  // (e.g. EmailBison's response with workspace { 16 fields }) needs the toggle
  // to surface clickable leaves without manual chevron-clicking each one.
  const [expandSignal, setExpandSignal] = useState(0)
  const [forceOpenState, setForceOpenState] = useState<boolean | undefined>(undefined)
  const expandAll = () => { setForceOpenState(true); setExpandSignal(s => s + 1) }
  const collapseAll = () => { setForceOpenState(false); setExpandSignal(s => s + 1) }

  const successRow = previewResults.find(r => r.status === 'success' && r.rawResponse !== undefined)
  const failedCount = previewResults.filter(r => r.status !== 'success').length
  const hasTree = view === 'tree' && !!successRow

  const removeField = (columnName: string) => {
    updateConfig({
      responseMapping: config.responseMapping.filter(m => m.columnName !== columnName),
    })
    const next = new Set(selectedFields); next.delete(columnName); setSelectedFields(next)
  }

  const addField = (jsonPath: string, columnName: string) => {
    if (config.responseMapping.some(m => m.jsonPath === jsonPath && m.columnName === columnName)) return
    updateConfig({
      responseMapping: [...config.responseMapping, { jsonPath, columnName }],
    })
    const next = new Set(selectedFields); next.add(columnName); setSelectedFields(next)
  }

  // Index existing mappings by jsonPath for quick lookup in the tree.
  const mappingByPath = new Map<string, string>()
  for (const m of config.responseMapping) mappingByPath.set(m.jsonPath, m.columnName)

  return (
    <div className="p-4 space-y-4">
      <PreviewErrorTroubleshoot
        sheetId={sheetId}
        config={config}
        previewResults={previewResults}
        onApplyFix={onApplyAIFix}
      />

      <div className="bg-gray-50 border border-gray-200 p-3 text-sm text-gray-700">
        Click any value below to save it as a column. We'll do the same lookup for every row when you Run All.
      </div>

      <div className="flex items-center justify-between">
        <div className="text-sm text-gray-600">
          {successRow
            ? `Showing the response for row ${previewResults.indexOf(successRow) + 1} of ${previewResults.length} preview rows${failedCount > 0 ? ` (${failedCount} failed)` : ''}.`
            : `None of the ${previewResults.length} preview rows got a response.`}
        </div>
        <div className="flex items-center gap-1">
          {view === 'tree' && (
            <>
              <button type="button" onClick={expandAll}
                className="text-xs px-2 py-1 bg-gray-100 text-gray-700 hover:bg-gray-200">Expand all</button>
              <button type="button" onClick={collapseAll}
                className="text-xs px-2 py-1 bg-gray-100 text-gray-700 hover:bg-gray-200">Collapse all</button>
              <span className="w-px h-4 bg-gray-300 mx-1" />
            </>
          )}
          <button
            type="button"
            onClick={() => setView('tree')}
            className={`text-xs px-2 py-1 ${view === 'tree' ? 'bg-cube-black text-white' : 'bg-gray-100 text-gray-700'}`}
          >Tree view</button>
          <button
            type="button"
            onClick={() => setView('list')}
            className={`text-xs px-2 py-1 ${view === 'list' ? 'bg-cube-black text-white' : 'bg-gray-100 text-gray-700'}`}
          >List view</button>
        </div>
      </div>

      {selectedFields.size > 0 && (
        <div className="border border-cube-black p-3">
          <div className="text-xs font-medium text-gray-700 mb-2">Columns to save ({selectedFields.size})</div>
          <div className="flex flex-wrap gap-2">
            {Array.from(selectedFields).map(name => (
              <span key={name} className="inline-flex items-center gap-1 bg-gray-100 text-sm text-gray-800 px-2 py-1">
                {name}
                <button type="button" onClick={() => removeField(name)} className="text-gray-500 hover:text-cube-black" aria-label={`Remove ${name}`}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {hasTree ? (
        <div className="border border-gray-200 p-3 max-h-96 overflow-auto font-mono text-xs">
          <JsonTree
            value={successRow!.rawResponse}
            path="$"
            mappingByPath={mappingByPath}
            onPick={addField}
            expandSignal={expandSignal}
            forceOpenState={forceOpenState}
          />
        </div>
      ) : (
        <PreviewFlatList
          previewResults={previewResults}
          selectedFields={selectedFields}
          setSelectedFields={setSelectedFields}
        />
      )}

      <div className="flex justify-between pt-3 border-t border-gray-200">
        <button onClick={onBack} className="btn-secondary">Back</button>
        <div className="flex items-center space-x-2">
          <button
            onClick={onCommit}
            disabled={isCommittingPreview || selectedFields.size === 0}
            className="btn-success flex items-center space-x-2"
            title="Save the preview values for these columns now (no full run)"
          >
            {isCommittingPreview ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
            <span>Add {selectedFields.size} column{selectedFields.size !== 1 ? 's' : ''}</span>
          </button>
          <button
            onClick={onStartRun}
            disabled={selectedFields.size === 0}
            className="btn-primary flex items-center space-x-2"
            title="Run on every row in the sheet"
          >
            <Play className="h-4 w-4" /><span>Run on all rows</span>
          </button>
        </div>
      </div>
    </div>
  )
}

