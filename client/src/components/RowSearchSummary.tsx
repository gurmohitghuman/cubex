import React from 'react'
import type { RowSearchQuery } from '@/utils/api'
import { formatRowCost } from './ai-modal/format'

// The top of the sources popup for one "(Data)" cell: what the row searched
// for (every search call, and whether it ran) and what the row cost.
export const RowSearchSummary: React.FC<{
  search: { searches: number; queries: RowSearchQuery[] } | null
  costUsd: number | null
}> = ({ search, costUsd }) => (
  <div className="border rounded-lg p-4 bg-white mb-6" data-testid="row-searches">
    {search && (search.queries.length === 0
      ? <div className="text-sm text-gray-700">No searches were reported for this row.</div>
      : <>
        <div className="text-sm font-medium text-gray-900 mb-2">
          Searched for ({search.queries.length > search.searches
            ? `${search.searches} of ${search.queries.length} ran`
            : `${search.searches} search${search.searches === 1 ? '' : 'es'}`})
        </div>
        <ul className="space-y-1">
          {search.queries.map((q, i) => (
            <li key={i} className={`text-sm ${q.ran ? 'text-gray-800' : 'text-gray-400'}`}>
              {q.query ? <>&ldquo;{q.query}&rdquo;</> : <span className="italic">A search whose words the model&apos;s own search didn&apos;t report</span>}
              {!q.ran && ' (not run: the row had reached its search limit)'}
            </li>
          ))}
        </ul>
      </>)}
    {costUsd !== null && (
      <div className={`text-xs text-gray-500${search ? ' mt-3' : ''}`}>
        This row cost {formatRowCost(costUsd)}{search ? ', search fees included' : ''}.
      </div>
    )}
  </div>
)
