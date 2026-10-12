import React from 'react'
import type { RuleCheck } from '@/utils/api'

const n = (v: number) => v.toLocaleString()

// What a rule does on the sheet: how many rows run, and the first rows with
// the values the rule read and whether each runs.
export const RuleSample: React.FC<{ check: RuleCheck }> = ({ check }) => (
  <div className="space-y-1.5" data-testid="run-if-check">
    <p className="text-xs text-gray-700">
      <span className="font-medium">{n(check.rows_passing)} of {n(check.rows_checked)} rows will run.</span>
      {check.rows_skipped > 0
        && ` The other ${n(check.rows_skipped)} show "⏭️ Condition not met" and cost nothing.`}
    </p>
    {check.sample.length > 0 && (
      <ul className="border border-gray-200 divide-y divide-gray-100 text-xs">
        {check.sample.map(r => (
          <li key={r.row_index} className="flex items-start gap-2 px-2 py-1">
            <span className="w-12 shrink-0 text-gray-500">Row {r.row_index + 1}</span>
            <span className="min-w-0 flex-1 truncate text-gray-700">
              {check.columns.map(c => `${c}: ${r.values[c] || '(empty)'}`).join(' · ')}
            </span>
            <span className={`shrink-0 ${r.passes ? 'text-green-700' : 'text-gray-500'}`}>
              {r.passes ? 'Runs' : 'Skipped'}
            </span>
          </li>
        ))}
      </ul>
    )}
  </div>
)
