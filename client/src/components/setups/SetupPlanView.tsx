import React from 'react'
import { SETUP_KIND_LABEL } from '@/utils/api/setups'
import type { PlanState } from './useSaveSetupForm'

// What the ticked columns make as a setup: its steps in the order they run,
// the columns a sheet needs for it, and the saved keys it uses (by name).
export const SetupPlanView: React.FC<{ plan: PlanState; picked: number }> = ({ plan, picked }) => {
  if (picked === 0) return <p className="text-sm text-gray-500">Tick at least one column.</p>
  if (plan.error) return <p className="text-sm text-red-600" data-testid="setup-plan-error">{plan.error}</p>
  if (!plan.result) return <p className="text-sm text-gray-500">Checking the columns…</p>
  const { steps, inputs, keys } = plan.result
  return (
    <div className={`bg-gray-50 border border-gray-200 p-4 space-y-3 text-sm ${plan.loading ? 'opacity-60' : ''}`}
      data-testid="setup-plan">
      <div>
        <p className="text-xs font-medium text-gray-700 mb-1">Runs in this order</p>
        <ol className="list-decimal list-inside space-y-0.5 text-gray-800">
          {steps.map(s => (
            <li key={s.column}>{s.column} <span className="text-gray-500">· {SETUP_KIND_LABEL[s.kind]}</span></li>
          ))}
        </ol>
      </div>
      <div>
        <p className="text-xs font-medium text-gray-700 mb-1">Needs these columns in the sheet you use it on</p>
        <p className="text-gray-800" data-testid="setup-plan-inputs">
          {inputs.length ? inputs.join(', ') : 'None: every column it reads, it makes itself.'}
        </p>
      </div>
      {keys.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-700 mb-1">Uses these saved keys</p>
          <p className="text-gray-800">
            {keys.join(', ')} <span className="text-gray-500">(by name only; the keys themselves stay in
            Settings)</span>
          </p>
        </div>
      )}
    </div>
  )
}
