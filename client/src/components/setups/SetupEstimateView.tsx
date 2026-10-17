import React from 'react'
import { SETUP_KIND_LABEL, type StepEstimate } from '@/utils/api/setups'
import type { EstimateState } from './useUseSetupForm'

const usd = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`)
const range = (low: number, high: number) => (low === high ? usd(low) : `${usd(low)} to ${usd(high)}`)

function costOf(s: StepEstimate): string {
  if (s.mode === 'again' && s.rows === 0) return 'Nothing to run'
  if (s.free) return 'Free'
  if (s.sends_requests) return `${s.rows.toLocaleString()} requests`
  if (s.low_usd === null || s.high_usd === null) return 'No price'
  return range(s.low_usd, s.high_usd)
}

// What using the setup could cost, step by step, before it starts.
export const SetupEstimateView: React.FC<{ state: EstimateState }> = ({ state }) => {
  if (state.error) return <p className="text-sm text-red-600" data-testid="setup-estimate-error">{state.error}</p>
  if (!state.result) return <p className="text-sm text-gray-500">Working out what it would cost…</p>
  const e = state.result
  const n = e.unpriced.length
  const unpriced = n ? `; ${e.unpriced.join(', ')} ${n === 1 ? 'has' : 'have'} no price here` : ''
  return (
    <div className={`bg-gray-50 border border-gray-200 p-4 text-sm ${state.loading ? 'opacity-60' : ''}`}
      data-testid="setup-estimate">
      <p className="text-xs font-medium text-gray-700 mb-2">
        What it could cost on {e.rows.toLocaleString()} row{e.rows === 1 ? '' : 's'}
      </p>
      <table className="w-full">
        <tbody>
          {e.steps.map(s => (
            <tr key={s.column} className="align-top">
              <td className="py-0.5 pr-2 w-6 text-gray-500 whitespace-nowrap">{s.layer}.</td>
              <td className="py-0.5 pr-3 text-gray-800">
                {s.column} <span className="text-gray-500">· {SETUP_KIND_LABEL[s.kind]}</span>
                {s.mode === 'again' && !s.free && s.rows > 0 && (
                  <span className="block text-xs text-gray-500">
                    Carries on: {s.rows.toLocaleString()} row{s.rows === 1 ? '' : 's'} not done yet
                  </span>
                )}
                {s.note && <span className="block text-xs text-gray-500">{s.note}</span>}
              </td>
              <td className="py-0.5 text-right text-gray-800 whitespace-nowrap">{costOf(s)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 pt-2 border-t border-gray-200 flex justify-between font-medium text-gray-900">
        <span>Total</span><span data-testid="setup-estimate-total">{range(e.low_usd, e.high_usd)}</span>
      </p>
      <p className="mt-1 text-xs text-gray-500">
        Steps with the same number run side by side. A step that reads what an earlier one writes is priced at
        the most it could take{unpriced}.
        {e.steps.some(s => s.mode === 'again') && ' A step that carries on is priced on the rows it hasn\'t done.'}
      </p>
    </div>
  )
}
