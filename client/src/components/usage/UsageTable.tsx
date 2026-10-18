import React from 'react'
import type { UsageReport, UsageRow } from '@/utils/api'
import { columnMeta, columnName, money, perCell, startedText } from './usage-copy'

const TH = 'px-3 py-2 text-left text-xs font-medium text-gray-600'
const TD = 'px-3 py-2 text-sm text-gray-800 align-top'
const NUM = 'text-right tabular-nums'

function Label({ row, group }: { row: UsageRow; group: UsageReport['group_by'] }) {
  if (group === 'day') return <span>{row.day}</span>
  const meta = group === 'run'
    ? [row.what, row.status, row.column_deleted ? 'deleted column' : null].filter(Boolean).join(' · ')
    : columnMeta(row)
  return (
    <span className="block min-w-0">
      <span className={`block truncate ${row.column_deleted ? 'text-gray-500 line-through' : ''}`}
        title={columnName(row)}>{columnName(row)}</span>
      {meta && <span className="block truncate text-xs text-gray-500" title={meta}>{meta}</span>}
    </span>
  )
}

// One row per column, day or run; costs right-aligned. A deleted column keeps
// its last name, struck through.
export const UsageTable: React.FC<{ report: UsageReport }> = ({ report }) => {
  const group = report.group_by
  return (
    <div className="border border-gray-200 overflow-x-auto">
      <table className="w-full" data-testid="usage-table">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr>
            {group === 'run' && <th className={TH}>Started (UTC)</th>}
            <th className={TH}>{group === 'day' ? 'Day (UTC)' : 'Column'}</th>
            {group !== 'run' && <th className={`${TH} ${NUM}`}>Runs</th>}
            <th className={`${TH} ${NUM}`}>Cells</th>
            <th className={`${TH} ${NUM}`}>Cost</th>
            <th className={`${TH} ${NUM}`}>Per cell</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {report.rows.map((r, i) => (
            <tr key={r.run_id ?? r.day ?? `${r.sheet_id}:${r.column}:${r.column_deleted}:${i}`}>
              {group === 'run' && (
                <td className={`${TD} whitespace-nowrap text-gray-600`}>{startedText(r.started_at)}</td>
              )}
              <td className={`${TD} max-w-[16rem]`}><Label row={r} group={group} /></td>
              {group !== 'run' && <td className={`${TD} ${NUM}`}>{r.runs.toLocaleString()}</td>}
              <td className={`${TD} ${NUM}`}>
                {r.cells.toLocaleString()}
                {r.reused_cells > 0 && (
                  <span className="block text-xs text-gray-500">{r.reused_cells.toLocaleString()} reused</span>
                )}
              </td>
              <td className={`${TD} ${NUM}`}>{money(r.total_cost_usd)}</td>
              <td className={`${TD} ${NUM} text-gray-600`}>{perCell(r.cost_per_cell_usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
