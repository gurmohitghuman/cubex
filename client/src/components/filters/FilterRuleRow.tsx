import React from 'react'
import { X } from 'lucide-react'
import type { ColumnType } from '@/utils/api/types'
import {
  VALUE_FILTERS, isDateFilter, isListFilter, isNumberFilter, isRunColumn, isRunStateFilter, type FilterOp,
} from '@/lib/filters'
import type { DraftRule } from '@/lib/filter-draft'
import { ValuePicker } from '../aggrid/ValuePicker'
import { DateValueInput } from './DateValueInput'

export interface RuleContext {
  sheetId?: string
  columns: string[]
  columnTypes: Record<string, ColumnType>
  hasRunColumns: boolean
}

const RUN_LABELS: Array<[FilterOp, string]> = [
  ['has_error', 'Has an error'], ['has_result', 'Has a result'], ['not_run', 'Is not run yet'],
  ['condition_not_met', 'Kept out by "Only run if"'], ['running', 'Is still running'],
  ['out_of_date', 'Is out of date'],
]
const TEXT = VALUE_FILTERS.filter(f => !isNumberFilter(f.op) && !isDateFilter(f.op))
const NUMBER = VALUE_FILTERS.filter(f => isNumberFilter(f.op))
const DATE = VALUE_FILTERS.filter(f => isDateFilter(f.op))
const FIELD = 'text-sm border border-gray-300 rounded py-1 px-1.5 bg-white focus:outline-none '
  + 'focus:border-cube-black min-w-0'
// Deep in groups the selects give way first; the value keeps room to read.
const VALUE = 'flex-1 min-w-[7rem]'

// The operators a rule can use on its column: any run column takes only run
// states; a run's column takes them beside the others.
function opsFor(column: string, ctx: RuleContext): Array<[string, Array<[FilterOp, string]>]> {
  const run: [string, Array<[FilterOp, string]>] = ['Run state', RUN_LABELS]
  if (!column) return [run]
  const value: Array<[string, Array<[FilterOp, string]>]> = [
    ['Text', TEXT.map(f => [f.op, f.label])], ['Number', NUMBER.map(f => [f.op, f.label])],
    ['Date', DATE.map(f => [f.op, f.label])], ['Empty', [['empty', 'Is empty'], ['not_empty', 'Is not empty']]],
  ]
  return isRunColumn(ctx.columnTypes[column]) ? [...value, run] : value
}
const allows = (column: string, op: FilterOp, ctx: RuleContext) =>
  opsFor(column, ctx).some(([, ops]) => ops.some(([o]) => o === op))

// One rule of the filter panel. change(rule, apply): apply now (a pick), or
// wait for Enter or leaving the field (typing).
export const FilterRuleRow: React.FC<{
  rule: DraftRule
  ctx: RuleContext
  change: (rule: DraftRule, apply: boolean) => void
  commit: () => void
  remove: () => void
}> = ({ rule, ctx, change, commit, remove }) => {
  const [picking, setPicking] = React.useState(false)
  const set = (patch: Partial<DraftRule>, apply = true) => change({ ...rule, ...patch }, apply)
  const pickColumn = (column: string) => set(allows(column, rule.op, ctx) ? { column }
    : { column, op: column ? 'contains' : 'has_error' })
  // A new condition keeps the value: into a list as its one value, out of one
  // as its first, so a complete rule never drops out of the filter.
  const pickOp = (op: FilterOp) => {
    const patch: Partial<DraftRule> = { op }
    if (isListFilter(op) && !isListFilter(rule.op) && rule.value.trim()) patch.values = [rule.value.trim()]
    if (!isListFilter(op) && isListFilter(rule.op) && rule.values.length) patch.value = rule.values[0]
    set(patch)
  }
  const list = isListFilter(rule.op)
  const noValue = isRunStateFilter(rule.op) || rule.op === 'empty' || rule.op === 'not_empty'
  return (
    <div className="flex-1 min-w-0" data-testid="filter-rule">
      <div className="flex items-center gap-1.5 min-w-0">
        <button type="button" role="switch" aria-checked={rule.enabled} onClick={() => set({ enabled: !rule.enabled })}
          aria-label="Rule on"
          title={rule.enabled ? 'On: click to see the rows without this rule' : 'Off: click to turn it on'}
          className={`relative h-4 w-7 flex-shrink-0 rounded-full transition-colors ${
            rule.enabled ? 'bg-cube-black' : 'bg-gray-400'}`}>
          <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
            rule.enabled ? 'left-3.5' : 'left-0.5'}`} />
        </button>
        <div className={`flex items-center gap-1.5 flex-1 min-w-0 ${rule.enabled ? '' : 'opacity-50'}`}>
          <select value={rule.column} onChange={e => pickColumn(e.target.value)} aria-label="Column"
            className={`${FIELD} w-36 shrink`}>
            {ctx.hasRunColumns && <option value="">Any run column</option>}
            {!rule.column && !ctx.hasRunColumns && <option value="">Pick a column</option>}
            {ctx.columns.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={rule.op} onChange={e => pickOp(e.target.value as FilterOp)} aria-label="Condition"
            className={`${FIELD} w-40 shrink`}>
            {opsFor(rule.column, ctx).map(([label, ops]) => (
              <optgroup key={label} label={label}>
                {ops.map(([op, text]) => <option key={op} value={op}>{text}</option>)}
              </optgroup>
            ))}
          </select>
          {noValue ? <span className={VALUE} />
            : list ? (
              <button type="button" onClick={() => setPicking(!picking)}
                className={`${FIELD} ${VALUE} text-left truncate`} aria-expanded={picking}>
                {rule.values.length ? rule.values.join(', ') : 'Pick values…'}
              </button>
            ) : isDateFilter(rule.op) ? (
              <DateValueInput key={`${rule.id}:${rule.op}`} value={rule.value} onChange={value => set({ value }, false)}
                onCommit={commit} onBlur={commit} className={`${FIELD} ${VALUE}`} />
            ) : (
              <input value={rule.value} onChange={e => set({ value: e.target.value }, false)} onBlur={commit}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit() } }} aria-label="Value"
                placeholder={isNumberFilter(rule.op) ? 'A number…' : 'Text…'} className={`${FIELD} ${VALUE}`} />
            )}
        </div>
        <button type="button" onClick={remove} aria-label="Remove this rule" title="Remove this rule"
          className="p-1 text-gray-400 hover:text-gray-800 flex-shrink-0"><X className="h-3.5 w-3.5" /></button>
      </div>
      {list && picking && (
        <div className="mt-1.5 ml-9 mr-7 p-2 border border-gray-200 rounded bg-gray-50">
          <ValuePicker sheetId={ctx.sheetId} column={rule.column} picked={rule.values}
            onChange={values => set({ values })} />
          <button type="button" onClick={() => setPicking(false)}
            className="mt-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded px-2 py-0.5">
            Done
          </button>
        </div>
      )}
    </div>
  )
}
