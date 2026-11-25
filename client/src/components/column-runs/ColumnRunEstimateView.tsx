import React from 'react'
import { RUN_COLUMN_KIND_LABEL, type ColumnEstimate, type ColumnRunEstimate } from '@/utils/api/column-runs'
import type { PreviewState } from '@/hooks/useTypedReads'

const usd = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`)
const range = (low: number, high: number) => (low === high ? usd(low) : `${usd(low)} to ${usd(high)}`)
const rowsOf = (n: number) => `${n.toLocaleString()} row${n === 1 ? '' : 's'}`

function costOf(c: ColumnEstimate): string {
  if (c.rows === 0) return 'Nothing to run'
  if (c.sends_requests) return `${c.rows.toLocaleString()} request${c.rows === 1 ? '' : 's'}`
  if (c.low_usd === null || c.high_usd === null) return 'No price'
  return c.at_most ? `up to ${usd(c.high_usd)}` : range(c.low_usd, c.high_usd)
}

// What running the chosen columns could cost, column by column, in the order they run.
export const ColumnRunEstimateView: React.FC<{ state: PreviewState<ColumnRunEstimate> }> = ({ state }) => {
  if (state.error) return <p className="text-sm text-red-600" data-testid="column-run-estimate-error">{state.error}</p>
  if (!state.result) return <p className="text-sm text-gray-500">Working out what it would cost…</p>
  const e = state.result
  const n = e.unpriced.length
  return (
    <div className={`bg-gray-50 border border-gray-200 p-4 text-sm ${state.loading ? 'opacity-60' : ''}`}
      data-testid="column-run-estimate">
      <table className="w-full">
        <tbody>
          {e.columns.map(c => (
            <tr key={c.column} className="align-top" data-testid="column-run-estimate-row">
              <td className="py-0.5 pr-2 w-6 text-gray-500 whitespace-nowrap">{c.layer}.</td>
              <td className="py-0.5 pr-3 text-gray-800">
                {c.column} <span className="text-gray-500">· {RUN_COLUMN_KIND_LABEL[c.kind]}</span>
                {c.rows > 0 && !c.sends_requests && (
                  <span className="block text-xs text-gray-500">{rowsOf(c.rows)}</span>
                )}
                {c.note && c.rows > 0 && <span className="block text-xs text-gray-500">{c.note}</span>}
              </td>
              <td className="py-0.5 text-right text-gray-800 whitespace-nowrap">{costOf(c)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 pt-2 border-t border-gray-200 flex justify-between font-medium text-gray-900">
        <span>Total</span><span data-testid="column-run-estimate-total">{range(e.low_usd, e.high_usd)}</span>
      </p>
      <p className="mt-1 text-xs text-gray-500">
        Columns with the same number run side by side; a column waits for the ones before it that it reads.
        {e.columns.some(c => c.sends_requests && c.rows > 0)
          && ' An HTTP API column sends one request a row to your API, which Cubex has no price for.'}
        {n > 0 && ` ${e.unpriced.join(', ')} ${n === 1 ? 'has' : 'have'} no price here.`}
      </p>
      {e.ceiling_problem && (
        <p className="mt-2 text-xs text-red-600" data-testid="column-run-over">{e.ceiling_problem}</p>
      )}
    </div>
  )
}
