import React from 'react'
import { Link } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { DEDUPE_MATCHES, type DedupeMatch } from '@/lib/dedupe'
import { plural } from '@/lib/utils'
import type { AutoDedupeKeep, AutoDedupeView } from '@/utils/api'
import type { AutoDedupeForm } from './useAutoDedupeForm'

const LABEL = 'block text-xs font-medium text-gray-700 mb-1'

const KEEPS: ReadonlyArray<{ id: AutoDedupeKeep; label: string; help: string }> = [
  {
    id: 'oldest', label: 'Oldest row',
    help: 'The row already in the sheet stays. A new row with the same key goes to the trash.',
  },
  {
    id: 'newest', label: 'Newest row',
    help: 'A new row replaces the older rows with its key. Their cells, enriched ones too, go to the trash.',
  },
]

// What it has done so far, while it is on.
const Status: React.FC<{ view: AutoDedupeView; sheetId: string; onRemoveNow: () => void }> = (
  { view, sheetId, onRemoveNow },
) => (
  <div className="bg-gray-50 border border-gray-200 px-3 py-2 text-sm text-gray-700 space-y-1"
    data-testid="auto-dedupe-status">
    {view.state === 'building' ? (
      <p className="flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Getting ready: reading the keys of the rows already here. Rows that arrive meanwhile are checked once
        it&apos;s done.
      </p>
    ) : (
      <p>
        On since {new Date(`${view.since.replace(' ', 'T')}Z`)
          .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.{' '}
        {view.removed_rows === 0 ? 'No row removed yet.' : `${plural(view.removed_rows, 'row')} removed so far.`}
        {view.removed_rows > 0 && (
          <> <Link className="underline" to={`/trash?sheet=${sheetId}&how=auto_dedupe`}
            data-testid="auto-dedupe-trash-link">See them in the trash</Link></>
        )}
      </p>
    )}
    {view.waiting_rows > 0 && (
      <p>{plural(view.waiting_rows, 'row')} still to check: a run is working on a row they match, or the sheet is
        busy.</p>
    )}
    {!!view.shared_rows && (
      <p>
        {plural(view.shared_rows, 'row')} already in the sheet {view.shared_rows === 1 ? 'shares' : 'share'} a key
        with an older row. Auto-dedupe doesn&apos;t change rows already here:{' '}
        <button type="button" className="underline" onClick={onRemoveNow}>Remove now</button> cleans those up once.
      </p>
    )}
  </div>
)

interface Props { form: AutoDedupeForm; view: AutoDedupeView | null; sheetId: string; onRemoveNow: () => void }

// Auto-dedupe's choices: the key column, how it matches, which row stays.
export const AutoDedupePanel: React.FC<Props> = ({ form: f, view, sheetId, onRemoveNow }) => {
  if (f.eligible.length === 0) {
    return (
      <p className="text-sm text-gray-600">
        Add a column rows arrive with first. AI, HTTP and other columns Cubex fills can&apos;t be the key.
      </p>
    )
  }
  return (
    <div className="space-y-5" data-testid="auto-dedupe-form">
      {view && <Status view={view} sheetId={sheetId} onRemoveNow={onRemoveNow} />}
      <div>
        <span className={LABEL}>Key column</span>
        <div className="flex items-center gap-2">
          <select className="input flex-1 min-w-0" aria-label="Key column" value={f.column}
            onChange={e => f.setColumn(e.target.value)} data-testid="auto-dedupe-column">
            {f.eligible.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <span className="text-xs text-gray-500">as</span>
          <select className="input w-44" aria-label={`How ${f.column} matches`} value={f.match}
            onChange={e => f.setMatch(e.target.value as DedupeMatch)} data-testid="auto-dedupe-match">
            {DEDUPE_MATCHES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        <p className="text-xs text-gray-500 mt-1">{DEDUPE_MATCHES.find(m => m.id === f.match)?.help}</p>
      </div>
      <fieldset>
        <legend className={LABEL}>When rows share a key, keep the</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {KEEPS.map(k => (
            <label key={k.id} className="flex items-center gap-1.5 text-sm text-gray-700">
              <input type="radio" name="auto-dedupe-keep" value={k.id} checked={f.keep === k.id}
                onChange={() => f.setKeep(k.id)} className="border-gray-300 text-cube-black focus:ring-black" />
              {k.label}
            </label>
          ))}
        </div>
        <p className="text-xs text-gray-500 mt-1">{KEEPS.find(k => k.id === f.keep)?.help}</p>
        {f.trashDays === 0 && (
          <p className="text-xs text-amber-800 mt-1" data-testid="auto-dedupe-no-trash">
            Settings keeps deleted items 0 days, so the rows auto-dedupe removes are deleted for good, not kept in
            the trash.
          </p>
        )}
      </fieldset>
      <p className="text-xs text-gray-500">
        A row is checked when it arrives (a webhook, an import, the API) or when a key is typed into it. Blank
        cells and cells over 200 characters never match, and values that AI, HTTP or other columns write are
        never checked. Rows already here stay as they are.
      </p>
      {f.error && <p className="text-sm text-red-600" data-testid="auto-dedupe-error">{f.error}</p>}
    </div>
  )
}
