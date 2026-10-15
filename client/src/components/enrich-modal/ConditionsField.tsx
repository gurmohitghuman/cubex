import React from 'react'
import { Plus, X } from 'lucide-react'
import type { Condition, ConditionOp } from './draft'

// The operators row-selection.ts applies (text ones trim and ignore case).
export const CONDITION_OPS: Array<{ value: ConditionOp; label: string; needsValue: boolean }> = [
  { value: 'not_empty', label: 'is not empty', needsValue: false },
  { value: 'empty', label: 'is empty', needsValue: false },
  { value: 'eq', label: 'is', needsValue: true },
  { value: 'neq', label: 'is not', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'gt', label: 'is more than', needsValue: true },
  { value: 'lt', label: 'is less than', needsValue: true },
]
const needsValue = (op: ConditionOp) => CONDITION_OPS.find(o => o.value === op)?.needsValue ?? false

// The first problem with the conditions, or null.
export function conditionsProblem(conditions: Condition[], columns: string[]): string | null {
  for (const c of conditions) {
    if (!columns.includes(c.column)) return `The column "${c.column}" in Only run if isn't in this sheet anymore.`
    if (needsValue(c.op) && !c.value.trim()) return `Add a value to the Only run if condition on ${c.column}.`
    if ((c.op === 'gt' || c.op === 'lt') && !Number.isFinite(Number(c.value))) return `"${c.value}" isn't a number (Only run if on ${c.column}).`
  }
  return null
}

// "Only run if": every condition must pass (AND).
export const ConditionsField: React.FC<{ conditions: Condition[]; columns: string[]; onChange: (c: Condition[]) => void }> = ({
  conditions, columns, onChange,
}) => {
  const set = (i: number, patch: Partial<Condition>) => onChange(conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  return (
    <div className="space-y-1.5" data-testid="enrich-conditions">
      {conditions.map((c, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,8.5rem)_minmax(0,1fr)_auto] items-center gap-1">
          <select className="input py-1" value={c.column} onChange={e => set(i, { column: e.target.value })} aria-label="Column">
            {!columns.includes(c.column) && <option value={c.column}>{c.column}</option>}
            {columns.map(col => <option key={col} value={col}>{col}</option>)}
          </select>
          <select className="input py-1" value={c.op} onChange={e => set(i, { op: e.target.value as ConditionOp })} aria-label="Condition">
            {CONDITION_OPS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {needsValue(c.op)
            ? <input className="input py-1" value={c.value} placeholder="Value" onChange={e => set(i, { value: e.target.value })} aria-label="Value" />
            : <span />}
          <button type="button" onClick={() => onChange(conditions.filter((_, j) => j !== i))} aria-label="Remove condition"
            className="p-1 text-gray-400 hover:text-cube-black"><X className="h-3.5 w-3.5" /></button>
        </div>
      ))}
      <button type="button" disabled={columns.length === 0}
        onClick={() => onChange([...conditions, { column: columns[0], op: 'not_empty', value: '' }])}
        className="inline-flex items-center gap-1 text-xs text-gray-700 hover:text-cube-black disabled:opacity-50">
        <Plus className="h-3.5 w-3.5" />Add condition
      </button>
    </div>
  )
}
