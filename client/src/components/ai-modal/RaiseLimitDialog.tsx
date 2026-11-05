import React, { useEffect, useState } from 'react'
import { Loader2, Play } from 'lucide-react'
import Modal from '../Modal'
import { MoneyInput } from '../enrich-modal/MoneyInput'
import { aiAPI, type AiLimitView } from '@/utils/api'
import { leastLine, pauseLine, queuedLine, suggestLine, tooLow, tooLowLine } from './raise-limit'

interface Props {
  // The AI run that paused at its spend limit; null: closed.
  runId: string | null
  onClose: () => void
  // It resumed with the new limit.
  onResumed: () => void
  // Resume all: how many more runs at their limit ask after this one.
  queued?: number
}

// Resume for an AI run that paused at its spend limit (pause_reason
// spend_limit): it goes on only with a higher limit (server
// services/ai-run-limit.ts), so Resume asks for one here. It shows the
// column, why the run paused and the least limit the server takes (what it
// spent, plus what cut-off calls count, plus its next row's most), filled in
// with enough to finish, as an enrichment's pause does (PausedNotice.tsx).
// Read from a light route that never loads the run's results.
export const RaiseLimitDialog: React.FC<Props> = ({ runId, onClose, onResumed, queued = 0 }) => {
  const [view, setView] = useState<AiLimitView | null>(null)
  const [value, setValue] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!runId) return
    let alive = true
    setView(null); setError(null); setValue(null)
    aiAPI.spendLimit(runId).then(v => {
      if (!alive) return
      setView(v)
      setValue(v.suggest_usd)
    }).catch(() => { if (alive) setError("Couldn't load the run.") })
    return () => { alive = false }
  }, [runId])

  const paused = view?.status === 'paused'
  const short = !!view && value !== null && tooLow(value, view)
  const resume = async () => {
    if (!runId || value === null || short || busy || !paused) return
    setBusy(true); setError(null)
    try {
      await aiAPI.resumeRun(runId, value)
      onResumed()
      onClose()
    } catch (e: any) {
      setError(e?.response?.data?.error || "Couldn't resume the run.")
    } finally {
      setBusy(false)
    }
  }

  const more = queuedLine(queued)
  const filled = view && suggestLine(view)
  return (
    <Modal isOpen={!!runId} onClose={busy ? () => {} : onClose} panelClassName="max-w-md w-full"
      zClassName="z-[20010]">
      <div className="p-6 space-y-4" data-testid="ai-raise-limit">
        <h3 className="text-title text-gray-900">Raise the spend limit</h3>
        {view ? (
          <div className="space-y-2 text-sm text-gray-600">
            {view.column_name && <p className="font-medium text-gray-900">{view.column_name}</p>}
            <p data-testid="ai-raise-limit-why">{pauseLine(view)}</p>
            {paused ? <p data-testid="ai-raise-limit-least">{leastLine(view)}</p>
              : <p>It isn&apos;t paused any more, so there is nothing to resume.</p>}
          </div>
        ) : !error && <p className="text-sm text-gray-600">Loading the run...</p>}
        {view && paused && (
          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-3">
              <span>New limit</span>
              <MoneyInput key={runId} value={value} fallback={null} label="New limit" onChange={setValue} required />
            </div>
            {filled && <p className="text-xs text-gray-500">{filled}</p>}
          </div>
        )}
        {short && <p className="text-xs text-red-600">{tooLowLine(view!)}</p>}
        {error && <p className="text-xs text-red-600" data-testid="ai-raise-limit-error">{error}</p>}
        {more && <p className="text-xs text-gray-500">{more}</p>}
        <div className="flex justify-end space-x-3">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-primary flex items-center gap-1"
            disabled={!paused || value === null || short || busy} onClick={resume}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Raise and resume
          </button>
        </div>
      </div>
    </Modal>
  )
}
