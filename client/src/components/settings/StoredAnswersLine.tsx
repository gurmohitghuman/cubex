import React, { useCallback, useEffect, useState } from 'react'
import { Database, Loader2 } from 'lucide-react'
import { enrichAPI, type StoredAnswers } from '@/utils/api'
import { ConfirmDialog } from '../ConfirmDialog'
import { pruneLine, sizeLine } from './stored-answers-copy'

const POLL_MS = 2000

// "Stored answers" at the foot of the spend card: how much space enrichment
// answers take (a background count, with when it was counted) and the button
// that removes the provider's raw data from old answers. The server counts
// again when the last count is old, and after each prune; this polls while
// either is going.
export const StoredAnswersLine: React.FC = () => {
  const [view, setView] = useState<StoredAnswers | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [starting, setStarting] = useState(false)

  const load = useCallback(() => enrichAPI.storedAnswers()
    .then(v => { setView(v); setError(null) })
    .catch(e => setError(e?.response?.data?.error || "Couldn't read the stored answers.")), [])

  useEffect(() => { void load() }, [load])
  const busy = !!view && (view.counting || view.prune?.status === 'running')
  useEffect(() => {
    if (!busy) return
    const t = setTimeout(() => { void load() }, POLL_MS)
    return () => clearTimeout(t)
  }, [busy, view, load])

  const prune = async () => {
    setConfirming(false)
    setStarting(true)
    try {
      setView(await enrichAPI.pruneStoredAnswers())
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      setError(err?.response?.data?.error || "Couldn't start the prune.")
    } finally {
      setStarting(false)
    }
  }

  const days = view?.pruneDays ?? 90
  const running = view?.prune?.status === 'running'
  const last = view ? pruneLine(view) : null
  return (
    <div className="border-t border-gray-200 pt-3 space-y-2" data-testid="stored-answers">
      <ConfirmDialog
        isOpen={confirming}
        title={`Prune details older than ${days} days?`}
        message={`Answers from enrichment runs that ended over ${days} days ago lose the provider's raw data. `
          + 'Their result fields stay, so cells and the answer panel keep working, but the removed data '
          + "can't become a column anymore. This can't be undone."}
        confirmText="Prune" isDestructive
        onConfirm={() => { void prune() }}
        onCancel={() => setConfirming(false)}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-900 flex items-center gap-2 min-w-0">
          <Database className="h-4 w-4 flex-shrink-0 text-gray-500" />
          <span className="font-medium">Stored answers:</span>
          <span className="truncate" data-testid="stored-answers-size">
            {error ?? (view ? sizeLine(view) : 'Loading…')}
          </span>
        </p>
        <button type="button" className="btn-secondary text-sm flex-shrink-0 inline-flex items-center gap-1.5"
          disabled={!view || running || starting} onClick={() => setConfirming(true)}
          data-testid="stored-answers-prune">
          {(running || starting) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Prune details older than {days} days
        </button>
      </div>
      {last && <p className="text-xs text-gray-700" data-testid="stored-answers-prune-status">{last}</p>}
      <p className="text-xs text-gray-600">
        Each answer keeps the provider&apos;s raw data for the answer panel and Add as column. When a row is enriched
        again, its older answers lose that raw data on their own. Pruning keeps the result fields. The space it
        frees is reused by new data; the enrichments guide says how to shrink the database file.
      </p>
    </div>
  )
}
