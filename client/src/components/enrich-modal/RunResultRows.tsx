import React from 'react'
import type { EnrichRowResult } from '@/utils/api'
import { spent } from '@/lib/enrich-format'

interface Props {
  results: EnrichRowResult[]
  statusColumn: string | null
  outputColumns: string[]
}

// The status cell's tint, as the grid shows it (buildColumnDefs).
const tone = (cell: string) => (cell.startsWith('✅') ? 'text-green-700'
  : cell.startsWith('❌') ? 'text-red-600' : cell.startsWith('⏭️') ? 'text-gray-500' : 'text-gray-700')

// Rows a run wrote, as in the grid: the row and its first input, its status
// cell, the outputs it filled, and what it cost (sub-cent amounts keep their
// digits; "your key" calls carry no cost and show none).
export const RunResultRows: React.FC<Props> = ({ results, statusColumn, outputColumns }) => (
  <ul className="divide-y divide-gray-100 border border-gray-200" data-testid="enrich-result-rows">
    {results.map(r => {
      const cell = statusColumn ? r.cells[statusColumn] ?? '' : ''
      const values = outputColumns.map(c => r.cells[c] ?? '').filter(v => v.trim() !== '')
      return (
        <li key={r.rowIndex} className="px-3 py-2 text-xs" data-testid="enrich-result-row">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-gray-700">
              <span className="font-medium text-gray-900">Row {(r.rowIndex + 1).toLocaleString()}</span>
              {r.label && <span className="text-gray-500"> · {r.label}</span>}
            </span>
            {r.costUsd !== null && (
              <span className="flex-shrink-0 text-gray-600" data-testid="enrich-row-cost">{spent(r.costUsd)}</span>
            )}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            <span className={`max-w-[60%] flex-shrink-0 truncate ${tone(cell)}`} title={cell}>
              {cell || 'No status'}
            </span>
            {values.length > 0 && (
              <span className="min-w-0 truncate text-gray-600" title={values.join(' · ')}>{values.join(' · ')}</span>
            )}
          </div>
        </li>
      )
    })}
  </ul>
)
