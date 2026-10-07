import React, { useState } from 'react'
import { formatCost } from '@/components/ai-modal/format'
import { ENRICH_MAX_ROW_CAP_USD } from '@/lib/constants'
import { effectiveMode, type EnrichDraft, type RowCounts, type RowsMode } from './draft'
import { ConditionsField } from './ConditionsField'

interface Props {
  draft: EnrichDraft
  update: (patch: Partial<EnrichDraft>) => void
  counts: RowCounts
  columns: string[]
  defaultMaxCostPerRow: number | null
  defaultSpendLimit: number | null
}

const parseMoney = (text: string): number | null => {
  const n = Number(text.replace(/[$,\s]/g, ''))
  return text.trim() && Number.isFinite(n) && n > 0 ? n : null
}

// A dollar amount; empty means "use the default" (shown as the placeholder,
// in the summary's own format). Anything else that isn't above $0 is flagged.
const MoneyInput: React.FC<{ value: number | null; fallback: number | null; label: string; onChange: (v: number | null) => void }> = ({
  value, fallback, label, onChange,
}) => {
  const [text, setText] = useState(value === null ? '' : String(value))
  const invalid = text.trim() !== '' && parseMoney(text) === null
  return (
    <span className="inline-flex flex-col">
      <span className="relative inline-block">
        <span className="absolute left-2.5 top-1.5 text-sm text-gray-500">$</span>
        <input className={`input w-28 py-1 pl-6 ${invalid ? '!border-red-300' : ''}`} inputMode="decimal" value={text} aria-label={label}
          placeholder={fallback === null ? '' : formatCost(fallback).slice(1)}
          onChange={e => { setText(e.target.value); onChange(parseMoney(e.target.value)) }} />
      </span>
      {invalid && <span className="text-xs text-red-600 mt-0.5">Enter an amount above $0, or leave it empty.</span>}
    </span>
  )
}

const count = (n: number | null) => (n === null ? '…' : n.toLocaleString())

export const RowsLimitsPane: React.FC<Props> = ({ draft, update, counts, columns, defaultMaxCostPerRow, defaultSpendLimit }) => {
  const modes: Array<{ value: RowsMode; label: string; show: boolean }> = [
    { value: 'all', label: `All rows (${count(counts.all)})`, show: true },
    { value: 'filter', label: `Rows in the current filter (${count(counts.filter)})`, show: counts.filter !== null },
    { value: 'selected', label: `Selected rows (${count(counts.selected)})`, show: counts.selected > 0 },
  ]
  const shown = modes.filter(m => m.show)
  const cap = draft.maxCostPerRowUsd
  const lowCap = cap !== null && defaultMaxCostPerRow !== null && cap < defaultMaxCostPerRow - 1e-9
  const tooHigh = cap !== null && cap > ENRICH_MAX_ROW_CAP_USD

  return (
    <div className="space-y-4" data-testid="enrich-rows-limits">
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium text-gray-700 mb-1">Run on</legend>
        {shown.length === 1 ? <p className="text-sm text-gray-700">{shown[0].label}</p> : shown.map(m => (
          <label key={m.value} className="flex items-center gap-2 text-sm text-gray-700">
            <input type="radio" name="enrich-rows" checked={effectiveMode(draft.rowsMode, counts) === m.value} onChange={() => update({ rowsMode: m.value })}
              className="border-gray-300 text-cube-black focus:ring-black" />
            {m.label}
          </label>
        ))}
        <p className="text-xs text-gray-500">Rows missing an input are skipped and cost nothing.</p>
      </fieldset>

      <div className="space-y-1.5">
        <p className="text-sm font-medium text-gray-700">Only run if</p>
        <ConditionsField conditions={draft.conditions} columns={columns} onChange={conditions => update({ conditions })} />
      </div>

      <div className="space-y-1">
        <label className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
          <span className="w-28">Max per row</span>
          <MoneyInput value={cap} fallback={defaultMaxCostPerRow} label="Max per row" onChange={v => update({ maxCostPerRowUsd: v })} />
        </label>
        <p className={`text-xs ml-[7.5rem] ${tooHigh ? 'text-red-600' : lowCap ? 'text-amber-700' : 'text-gray-500'}`}>
          {tooHigh
            ? `Max per row can be at most $${ENRICH_MAX_ROW_CAP_USD.toLocaleString()}.`
            : lowCap
              ? `Below ${formatCost(defaultMaxCostPerRow!)}, later providers can be skipped, and rows show "Budget ran out".`
              : 'Lets every provider you picked answer. Empty uses the default.'}
        </p>
      </div>

      <div className="space-y-1">
        <label className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
          <span className="w-28">Stop the run at</span>
          <MoneyInput value={draft.spendLimitUsd} fallback={defaultSpendLimit} label="Stop the run at"
            onChange={v => update({ spendLimitUsd: v })} />
        </label>
        <p className="text-xs text-gray-500 ml-[7.5rem]">The run pauses when it has spent this much. Empty uses the estimate&apos;s high end.</p>
      </div>

      <label className="flex items-start gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={draft.fresh} onChange={e => update({ fresh: e.target.checked })}
          className="mt-0.5 border-gray-300 text-cube-black focus:ring-black" />
        <span>
          Always fetch fresh data
          <span className="block text-xs text-gray-500">Otherwise treg can answer a repeat lookup from its store, which can be cheaper.</span>
        </span>
      </label>
    </div>
  )
}
