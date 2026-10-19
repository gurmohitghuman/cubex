import React from 'react'
import { Select } from '@/components/ui/Select'
import type { RowsStatus } from '@/utils/api/waterfall'
import { RunIfField } from '@/components/run-if/RunIfField'
import type { WaterfallDraft } from './draft'

interface Props {
  sheetId: string
  draft: WaterfallDraft
  update: (patch: Partial<WaterfallDraft>) => void
  selectedCount: number
  active: boolean
}

const STATUS: Array<[RowsStatus, string]> = [
  ['not_enriched', 'Rows not run yet'], ['no_result', 'Rows without a result'], ['failed', 'Failed rows'],
  ['any', 'Every row again'],
]

// The columns it adds, which rows it runs, "Only run if", the run's limit and
// "always call again".
export const OptionsSection: React.FC<Props> = ({ sheetId, draft, update, selectedCount, active }) => (
  <div className="space-y-3" data-testid="waterfall-options">
    <label className="flex items-start gap-2 text-sm text-gray-700">
      <input type="checkbox" className="mt-0.5" checked={draft.answeredBy}
        onChange={e => update({ answeredBy: e.target.checked })} />
      <span>A column naming the step that answered<span className="block text-xs text-gray-500">
        &quot;{draft.columnName || 'Result'} (Answered by)&quot;</span></span>
    </label>
    <label className="flex items-start gap-2 text-sm text-gray-700">
      <input type="checkbox" className="mt-0.5" checked={draft.hideStepColumns}
        onChange={e => update({ hideStepColumns: e.target.checked })} />
      <span>Hide the step columns<span className="block text-xs text-gray-500">
        Each step&apos;s own value goes in its column, hidden in every view (show them from the columns picker).
      </span></span>
    </label>
    <div className="space-y-1">
      <p className="meta-label">Rows</p>
      <Select<string> className="w-full" value={draft.rowsMode} label="Rows"
        onChange={v => update({ rowsMode: v as WaterfallDraft['rowsMode'] })} options={[
          { value: 'all', label: 'Every row' },
          { value: 'filter', label: "The rows the sheet's filter shows" },
          ...(selectedCount > 0
            ? [{ value: 'selected', label: `The ${selectedCount.toLocaleString()} selected rows` }] : []),
        ]} />
      {draft.continueColumn && (
        <Select<string> className="w-full" value={draft.rowsStatus} label="Which of its rows"
          onChange={v => update({ rowsStatus: v as RowsStatus })}
          options={STATUS.map(([v, l]) => ({ value: v, label: l }))} />
      )}
    </div>
    <RunIfField sheetId={sheetId} value={draft.runIf} onChange={runIf => update({ runIf })} active={active} />
    <label className="block space-y-1">
      <span className="meta-label">Run limit (treg and AI, optional)</span>
      <input className="input w-32" type="number" min={0} step="0.01" value={draft.spendLimitUsd ?? ''}
        aria-label="Run limit" placeholder="Rows × most"
        onChange={e => update({ spendLimitUsd: e.target.value ? Number(e.target.value) : null })} />
    </label>
    <label className="flex items-start gap-2 text-sm text-gray-700">
      <input type="checkbox" className="mt-0.5" checked={draft.fresh}
        onChange={e => update({ fresh: e.target.checked })} />
      <span>Always call again<span className="block text-xs text-gray-500">
        Don&apos;t reuse answers an earlier run already found.</span></span>
    </label>
  </div>
)
