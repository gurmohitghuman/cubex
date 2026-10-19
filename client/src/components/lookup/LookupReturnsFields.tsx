import React from 'react'
import type { LookupReturns } from '@/utils/api'
import { LOOKUP_LIST_MAX } from '@/lib/constants'
import { RETURNS_LABEL } from './lookup-copy'
import { Select } from '@/components/ui/Select'

interface Props {
  // The other sheet's columns (empty until a sheet is picked).
  columns: string[]
  returns: LookupReturns
  onReturns: (r: LookupReturns) => void
  returnColumn: string
  onReturnColumn: (c: string) => void
  // 'list': the columns each match carries, null = all of them.
  listColumns: string[] | null
  onListColumns: (c: string[] | null) => void
  limit: number
  onLimit: (n: number) => void
}

const LABEL = 'block text-xs font-medium text-gray-700 mb-1'

// What the lookup writes: a column of the first match, yes/no, a count, or the
// matching rows as a JSON list (which columns, how many).
export const LookupReturnsFields: React.FC<Props> = p => (
  <div className="space-y-3">
    <div>
      <label htmlFor="lookup-returns" className={LABEL}>Write</label>
      <Select id="lookup-returns" className="w-full" value={p.returns} label="Write"
        onChange={v => p.onReturns(v as LookupReturns)} testId="lookup-returns"
        options={(Object.keys(RETURNS_LABEL) as LookupReturns[]).map(r => ({ value: r, label: RETURNS_LABEL[r] }))} />
    </div>
    {p.returns === 'value' && (
      <div>
        <label htmlFor="lookup-return-column" className={LABEL}>Column to write</label>
        <Select id="lookup-return-column" className="w-full" value={p.returnColumn} label="Column to write"
          onChange={p.onReturnColumn} testId="lookup-return-column" placeholder="Pick a column"
          options={[
            ...(p.returnColumn && !p.columns.includes(p.returnColumn)
              ? [{ value: p.returnColumn, label: `${p.returnColumn} (deleted)`, disabled: true }] : []),
            ...p.columns.map(c => ({ value: c, label: c })),
          ]} />
        <p className="text-xs text-gray-500 mt-1">From the first matching row, top of the sheet first.</p>
      </div>
    )}
    {p.returns === 'list' && (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-gray-700">
          <label htmlFor="lookup-limit">Up to</label>
          <input id="lookup-limit" type="number" min={1} max={LOOKUP_LIST_MAX} value={p.limit}
            onChange={e => p.onLimit(Math.max(1, Math.min(LOOKUP_LIST_MAX, Number(e.target.value) || 1)))}
            className="input w-20" data-testid="lookup-limit" />
          <span>rows, written as a JSON list (a formula column can read it)</span>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={p.listColumns === null}
            onChange={e => p.onListColumns(e.target.checked ? null : [])} />
          Every column
        </label>
        {p.listColumns !== null && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 max-h-24 overflow-auto border border-gray-200 px-2 py-1">
            {[...p.listColumns.filter(c => !p.columns.includes(c)), ...p.columns].map(c => (
              <label key={c} className="flex items-center gap-1 text-xs text-gray-700">
                <input type="checkbox" checked={p.listColumns!.includes(c)}
                  onChange={e => p.onListColumns(e.target.checked
                    ? [...p.listColumns!, c] : p.listColumns!.filter(x => x !== c))} />
                {p.columns.includes(c) ? c : `${c} (deleted)`}
              </label>
            ))}
          </div>
        )}
      </div>
    )}
  </div>
)
