import React from 'react'
import { Loader2 } from 'lucide-react'
import { plural } from '@/lib/utils'
import type { DedupeSampleGroup, DedupeSampleRow } from '@/utils/api'
import type { DedupeCheckState } from './useDedupeForm'

const rowsLabel = (rows: DedupeSampleRow[]) =>
  `${rows.length === 1 ? 'Row' : 'Rows'} ${rows.map(r => r.row.toLocaleString()).join(', ')}`
const valuesOf = (r: DedupeSampleRow) => Object.values(r.values).filter(v => v.trim() !== '').join(' · ')

// One group: the row that stays and the rows that go, with the first removed
// row written differently (so "JO@ACME.COM " shows it matched). Values are
// cell data: rendered as text only.
const GroupRow: React.FC<{ group: DedupeSampleGroup; label?: string }> = ({ group, label }) => {
  const more = group.size - 1 - group.removed.length
  const kept = valuesOf(group.kept)
  const differs = group.removed.find(r => valuesOf(r) !== kept)
  return (
    <tr className="border-t border-gray-100 align-top">
      <td className="px-2 py-1 text-gray-900 truncate" title={valuesOf(group.kept)}>
        {label && <span className="text-gray-500">{label}: </span>}
        {valuesOf(group.kept)}
        <span className="block text-gray-500">Row {group.kept.row.toLocaleString()} stays</span>
      </td>
      <td className="px-2 py-1 text-gray-600">
        {group.removed.length > 0 ? rowsLabel(group.removed) : ''}
        {more > 0 && (
          <span className="text-gray-500">{group.removed.length > 0 ? ' and ' : ''}{plural(more, 'more row')}</span>
        )}
        {differs && (
          <span className="block text-gray-500 truncate" title={valuesOf(differs)}>
            Row {differs.row.toLocaleString()}: {valuesOf(differs)}
          </span>
        )}
      </td>
    </tr>
  )
}

// What removing would do: the counts, a few groups, the largest group, and a
// run that would refuse it. The last answer stays, dimmed, while the next loads.
export const DedupeCheckView: React.FC<{ state: DedupeCheckState; ready: boolean }> = ({ state, ready }) => {
  const { loading, result, error } = state
  let body: React.ReactNode
  if (!ready) body = <p className="text-xs text-gray-500">Pick a column to see what would be removed.</p>
  else if (error) body = <p className="text-xs text-red-600" data-testid="dedupe-check-error">{error}</p>
  else if (!result) body = <p className="text-xs text-gray-500">Checking every row…</p>
  else {
    const stay = result.rowsChecked - result.duplicateRows
    body = (
      <div className={`space-y-2 ${loading ? 'opacity-40' : ''}`}>
        <p className="text-sm text-gray-900" data-testid="dedupe-summary">
          {result.duplicateRows === 0
            ? `No duplicates in ${plural(result.rowsChecked, 'row')}.`
            : `${plural(result.duplicateRows, 'duplicate row')} in ${plural(result.groups, 'group')}. `
              + `${plural(stay, 'row')} stay.`}
        </p>
        {result.emptyKeyRows > 0 && (
          <p className="text-xs text-gray-500">
            {plural(result.emptyKeyRows, 'row')} missing a value to match on (empty, or not readable as picked) stay.
          </p>
        )}
        {result.blockedBy && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 px-2 py-1.5" role="alert">
            {result.blockedBy.message}
          </p>
        )}
        {result.samples.length > 0 && (
          <table className="w-full table-fixed text-xs border border-gray-200" data-testid="dedupe-samples">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="w-3/5 text-left font-medium px-2 py-1">Stays</th>
                <th className="text-left font-medium px-2 py-1">Removed</th>
              </tr>
            </thead>
            <tbody>
              {result.samples.map(g => <GroupRow key={g.kept.id} group={g} />)}
              {result.largest && <GroupRow group={result.largest} label="Largest group" />}
            </tbody>
          </table>
        )}
      </div>
    )
  }
  return (
    <div data-testid="dedupe-check">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="block text-xs font-medium text-gray-700">What would be removed</span>
        {ready && loading && <Loader2 className="h-3 w-3 animate-spin text-gray-400" aria-label="Checking" />}
      </div>
      {body}
    </div>
  )
}
