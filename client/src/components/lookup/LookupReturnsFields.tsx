import React from 'react'
import type { LookupReturns } from '@/utils/api'
import { LOOKUP_LIST_MAX } from '@/lib/constants'
import { RETURNS_LABEL } from './lookup-copy'

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
      <select id="lookup-returns" className="input w-full" value={p.returns}
        onChange={e => p.onReturns(e.target.value as LookupReturns)} data-testid="lookup-returns">
        {(Object.keys(RETURNS_LABEL) as LookupReturns[])
          .map(r => <option key={r} value={r}>{RETURNS_LABEL[r]}</option>)}
      </select>
    </div>
    {p.returns === 'value' && (
      <div>
        <label htmlFor="lookup-return-column" className={LABEL}>Column to write</label>
        <select id="lookup-return-column" className="input w-full" value={p.returnColumn}
          onChange={e => p.onReturnColumn(e.target.value)} data-testid="lookup-return-column">
          {!p.returnColumn && <option value="" disabled>Pick a column</option>}
          {p.returnColumn && !p.columns.includes(p.returnColumn) && (
            <option value={p.returnColumn} disabled>{p.returnColumn} (deleted)</option>
          )}
          {p.columns.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
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
