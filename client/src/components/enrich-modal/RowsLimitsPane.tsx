import React from 'react'
import { formatCost } from '@/components/ai-modal/format'
import { ENRICH_MAX_ROW_CAP_USD } from '@/lib/constants'
import type { EnrichRowCounts } from '@/utils/api'
import { effectiveMode, type EnrichDraft, type RowCounts, type RowsMode, type RowsStatus } from './draft'
import { ConditionsField } from './ConditionsField'
import { MoneyInput } from './MoneyInput'

interface Props {
  draft: EnrichDraft
  update: (patch: Partial<EnrichDraft>) => void
  counts: RowCounts
  // On a column a run already made: its rows in scope by status (null: counting).
  continuing: boolean
  byStatus: EnrichRowCounts | null
  columns: string[]
  defaultMaxCostPerRow: number | null
  defaultSpendLimit: number | null
  // The provider that bills this tool directly (the team's own key at treg):
  // treg's limits can't stop its charges, so they aren't offered.
  billedBy: string | null
}

const count = (n: number | null | undefined) => (n === null || n === undefined ? '…' : n.toLocaleString())

const Radio: React.FC<{ name: string; checked: boolean; onChange: () => void; label: string }> = (r) => (
  <label className="flex items-center gap-2 text-sm text-gray-700">
    <input type="radio" name={r.name} checked={r.checked} onChange={r.onChange}
      className="border-gray-300 text-cube-black focus:ring-black" />
    {r.label}
  </label>
)

export const RowsLimitsPane: React.FC<Props> = (p) => {
  const { draft, update, counts, byStatus } = p
  const modes: Array<{ value: RowsMode; label: string; show: boolean }> = [
    { value: 'all', label: `All rows (${count(counts.all)})`, show: true },
    { value: 'filter', label: `Rows in the current filter (${count(counts.filter)})`, show: counts.filter !== null },
    { value: 'selected', label: `Selected rows (${count(counts.selected)})`, show: counts.selected > 0 },
  ]
  const shown = modes.filter(m => m.show)
  const statuses: Array<{ value: RowsStatus; label: string }> = [
    { value: 'not_enriched', label: `Rows not enriched yet (${count(byStatus?.notEnriched)})` },
    { value: 'no_result', label: `Rows without a result (${count(byStatus?.noResult)})` },
    { value: 'failed', label: `Rows that failed (${count(byStatus?.failed)})` },
    { value: 'any', label: `All of them again (${count(byStatus?.total)})` },
  ]
  const cap = draft.maxCostPerRowUsd
  const lowCap = cap !== null && p.defaultMaxCostPerRow !== null && cap < p.defaultMaxCostPerRow - 1e-9
  const tooHigh = cap !== null && cap > ENRICH_MAX_ROW_CAP_USD
  const capTone = tooHigh ? 'text-red-600' : lowCap ? 'text-amber-700' : 'text-gray-500'

  return (
    <div className="space-y-4" data-testid="enrich-rows-limits">
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium text-gray-700 mb-1">Run on</legend>
        {shown.length === 1 ? <p className="text-sm text-gray-700">{shown[0].label}</p> : shown.map(m => (
          <Radio key={m.value} name="enrich-rows" label={m.label} onChange={() => update({ rowsMode: m.value })}
            checked={effectiveMode(draft.rowsMode, counts) === m.value} />
        ))}
        <p className="text-xs text-gray-500">Rows missing an input are skipped and cost nothing.</p>
      </fieldset>

      {p.continuing && (
        <fieldset className="space-y-1.5" data-testid="enrich-rows-status">
          <legend className="text-sm font-medium text-gray-700 mb-1">Which rows</legend>
          {statuses.map(s => (
            <Radio key={s.value} name="enrich-rows-status" label={s.label} checked={draft.rowsStatus === s.value}
              onChange={() => update({ rowsStatus: s.value })} />
          ))}
          <p className="text-xs text-gray-500">
            {draft.rowsStatus === 'not_enriched'
              ? 'Only rows whose cell in this column is empty run.'
              : draft.rowsStatus === 'any'
                ? 'Runs every row again and replaces its results. Each row costs again.'
                : 'Rows run again replace their results. Each row costs again.'}
          </p>
        </fieldset>
      )}

      <div className="space-y-1.5">
        <p className="text-sm font-medium text-gray-700">Only run if</p>
        <ConditionsField conditions={draft.conditions} columns={p.columns}
          onChange={conditions => update({ conditions })} />
      </div>

      {p.billedBy ? (
        <p className="text-xs text-gray-600">
          No spend limits here: {p.billedBy} bills these calls directly, not your treg balance.
        </p>
      ) : (<>
        <div className="space-y-1">
          <label className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
            <span className="w-28">Max per row</span>
            <MoneyInput value={cap} fallback={p.defaultMaxCostPerRow} label="Max per row"
              onChange={v => update({ maxCostPerRowUsd: v })} />
          </label>
          <p className={`text-xs ml-[7.5rem] ${capTone}`}>
            {tooHigh
              ? `Max per row can be at most $${ENRICH_MAX_ROW_CAP_USD.toLocaleString()}.`
              : lowCap
                ? `Below ${formatCost(p.defaultMaxCostPerRow!)}, later providers can be skipped, `
                  + 'and rows show "Budget ran out".'
                : 'Lets every provider you picked answer. Empty uses the default.'}
          </p>
        </div>

        <div className="space-y-1">
          <label className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
            <span className="w-28">Stop the run at</span>
            <MoneyInput value={draft.spendLimitUsd} fallback={p.defaultSpendLimit} label="Stop the run at"
              onChange={v => update({ spendLimitUsd: v })} />
          </label>
          <p className="text-xs text-gray-500 ml-[7.5rem]">
            The run pauses when it has spent this much. Empty uses the estimate&apos;s high end.
          </p>
        </div>
      </>)}

      <label className="flex items-start gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={draft.fresh} onChange={e => update({ fresh: e.target.checked })}
          className="mt-0.5 border-gray-300 text-cube-black focus:ring-black" />
        <span>
          Always fetch fresh data
          <span className="block text-xs text-gray-500">
            Otherwise treg can answer a repeat lookup from its store, which can be cheaper.
          </span>
        </span>
      </label>
    </div>
  )
}
