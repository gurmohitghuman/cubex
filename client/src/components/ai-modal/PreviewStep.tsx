import React, { useState } from 'react'
import { CheckCircle, Edit3, Loader2, Play, Save } from 'lucide-react'
import { AIPreview } from './types'
import { estimateRunCost, formatTokens, formatCost } from './format'
import { plural } from '@/lib/utils'

interface Props {
  previewResults: AIPreview[]
  setPreviewResults: React.Dispatch<React.SetStateAction<AIPreview[]>>
  isCommittingPreview: boolean
  // True while preview rows are still streaming in. Locks editing + the commit/run
  // actions so the user can't act on a partial result set (and matches the request
  // that the popover be read-only during preview generation).
  isGeneratingPreview: boolean
  // How many rows the stream will deliver. Corrected to the server's actual count
  // once {type:'done'} lands, so a short sheet (fewer than the requested size) doesn't
  // leave dangling "Generating…" placeholders.
  expectedRows: number
  // UNFILTERED count of rows "Run All Rows" will process, from the preview server.
  // Drives the cost estimate so it matches what the run bills (not the client's
  // filter-aware sheet total). 0 until the preview's {type:'done'} arrives.
  runTargetRows: number
  // Selected model's per-token pricing (from the OpenRouter model list). Undefined ⇒
  // no estimate shown.
  modelPricing?: { prompt: string; completion: string }
  // Whether the run uses web tools — makes per-row cost heavy-tailed, so the estimate
  // is flagged as less reliable.
  usesWebTools: boolean
  nameError: string
  onBack: () => void
  onCommit: () => Promise<unknown>
  onStartRun: () => Promise<unknown>
}

export const PreviewStep: React.FC<Props> = ({
  previewResults, setPreviewResults, isCommittingPreview, isGeneratingPreview, expectedRows,
  runTargetRows, modelPricing, usesWebTools, nameError,
  onBack, onCommit, onStartRun,
}) => {
  const [editing, setEditing] = useState<{ rowIndex: number; value: string } | null>(null)
  // Rows not yet returned by the stream — render as muted "Generating…" placeholders
  // so the user sees the full target count immediately and watches rows fill in. Only
  // shown WHILE generating, so a final count mismatch can't strand placeholders.
  // One slot per sample position, labelled by that position: rows stream back in
  // completion order, and labelling by arrival put answers under the wrong "Row N".
  const byPosition = new Map(previewResults.map((r, i) => [r.previewIndex ?? i, r]))
  const slotCount = Math.max(0, ...[...byPosition.keys()].map(k => k + 1), isGeneratingPreview ? expectedRows : 0)
  // Estimated token/cost for running all rows — only meaningful once the preview has
  // finished (we have token usage for the sample). Null when no usage / no pricing.
  const estimate = isGeneratingPreview ? null : estimateRunCost(previewResults, runTargetRows, modelPricing)

  return (
    <div className="p-4 space-y-4">
      <div className="bg-white border border-cube-black p-3">
        <div className="flex items-start space-x-2">
          <div className="flex-shrink-0 mt-0.5 text-cube-black">👁</div>
          <div>
            <h4 className="text-sm font-medium text-cube-black">Preview Results</h4>
            <p className="text-xs text-cube-black mt-1">
              {isGeneratingPreview
                ? `Generating ${previewResults.length} / ${expectedRows} rows…`
                : 'Review the preview results below. You can edit values before proceeding.'}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {Array.from({ length: slotCount }, (_, slot) => byPosition.get(slot)).map((result, slot) => result ? (
          <div key={result.rowIndex} className="border border-gray-200 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-700">Row {slot + 1}</span>
              {result.error && <span className="text-xs bg-cube-black text-white px-2 py-1">Error</span>}
            </div>

            {editing?.rowIndex === result.rowIndex ? (
              <div className="space-y-2">
                <textarea value={editing.value}
                  onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                  className="input w-full h-20 resize-none text-sm" />
                <div className="flex justify-end space-x-2">
                  <button onClick={() => setEditing(null)} className="text-sm text-gray-600 hover:text-gray-800">Cancel</button>
                  <button
                    onClick={() => {
                      setPreviewResults(prev => prev.map(r =>
                        // Clear `error` on save — otherwise commit writes '' for any
                        // errored row (usePreviewHandlers), silently discarding the
                        // user's hand-entered fix for a row the model failed on.
                        r.rowIndex === result.rowIndex ? { ...r, value: editing.value, error: undefined } : r,
                      ))
                      setEditing(null)
                    }}
                    className="text-sm text-cube-black hover:text-gray-700 flex items-center space-x-1">
                    <Save className="h-3 w-3" /><span>Save</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="group">
                <p className="text-sm text-gray-800 whitespace-pre-wrap">{result.error || result.value}</p>
                {/* Editing is locked until the stream finishes — acting on a row
                    while others are still arriving is confusing and the commit
                    would use a partial set. */}
                {!isGeneratingPreview && (
                  <button onClick={() => setEditing({ rowIndex: result.rowIndex, value: result.value })}
                    className="mt-2 opacity-0 group-hover:opacity-100 text-xs text-gray-500 hover:text-gray-700 flex items-center space-x-1 transition-opacity">
                    <Edit3 className="h-3 w-3" /><span>Edit</span>
                  </button>
                )}
              </div>
            )}
          </div>
        ) : !isGeneratingPreview ? null : (
          // A row still streaming in, in its own slot.
          <div key={`pending-${slot}`} className="border border-gray-200 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-400">Row {slot + 1}</span>
            </div>
            <div className="flex items-center space-x-2 text-gray-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="text-sm">Generating…</span>
            </div>
          </div>
        ))}
      </div>

      {/* Estimated cost/tokens for running ALL rows — shown before the user commits to
          the full run so an expensive model/row count is visible up front. Rough by
          design (5-row sample, per-row variance), so it's a labeled RANGE. */}
      {estimate && (
        <div className="bg-gray-50 border border-gray-200 p-3 text-xs text-gray-700">
          <div className="flex items-center justify-between">
            <span className="font-medium text-cube-black">Estimated for all {plural(estimate.totalRows, 'row')}</span>
            <span className="font-medium text-cube-black">
              {estimate.isFree
                ? `~${formatTokens(estimate.tokensLow)}–${formatTokens(estimate.tokensHigh)} tokens · free`
                : `${formatCost(estimate.costLow)}–${formatCost(estimate.costHigh)}`}
            </span>
          </div>
          <p className="text-gray-500 mt-1">
            Rough estimate from {estimate.sampledRows} preview row{estimate.sampledRows === 1 ? '' : 's'}
            {!estimate.isFree && ` · ~${formatTokens(estimate.tokensLow)}–${formatTokens(estimate.tokensHigh)} tokens`}
            {usesWebTools && ' · web tools may add to actual cost'}
            . Actual cost varies per row.
          </p>
        </div>
      )}

      <div className="flex justify-between pt-4 border-t border-gray-200">
        {/* All actions are disabled while preview rows are still streaming. */}
        <button onClick={onBack} disabled={isGeneratingPreview} className="btn-secondary">Back to Configure</button>
        <div className="flex items-center space-x-2">
          <button onClick={onCommit} disabled={isGeneratingPreview || isCommittingPreview || !!nameError}
            className="btn-success flex items-center space-x-2"
            title="Add a new column with these preview results">
            {isCommittingPreview ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
            <span>Add Column</span>
          </button>
          <button onClick={onStartRun} disabled={isGeneratingPreview}
            className="btn-primary flex items-center space-x-2"
            title={estimate && !estimate.isFree
              ? `Run on all ${plural(estimate.totalRows, 'row')} — est. ${formatCost(estimate.costLow)}–${formatCost(estimate.costHigh)}`
              : 'Run on all rows'}>
            <Play className="h-4 w-4" /><span>Run All Rows</span>
          </button>
        </div>
      </div>
    </div>
  )
}
