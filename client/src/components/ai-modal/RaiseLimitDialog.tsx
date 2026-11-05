import React, { useEffect, useState } from 'react'
import { Loader2, Play } from 'lucide-react'
import Modal from '../Modal'
import { MoneyInput } from '../enrich-modal/MoneyInput'
import { aiAPI } from '@/utils/api'

interface Props {
  // The AI run that paused at its spend limit; null: closed.
  runId: string | null
  onClose: () => void
  // It resumed with the new limit.
  onResumed: () => void
}

// Dollars as the server says them: cents from a cent up, two significant figures below.
const money = (n: number) =>
  `$${n >= 0.01 || n <= 0 ? n.toFixed(2) : n.toLocaleString('en-US', { maximumSignificantDigits: 2 })}`
// A first guess for the new limit: twice the old one, at least ten cents, in cents.
const suggest = (limit: number) => Math.ceil(Math.max(limit * 2, 0.1) * 100 - 1e-9) / 100

// Resume for an AI run that paused at its spend limit (pause_reason
// spend_limit): it goes on only with a higher limit (server
// services/ai-run-limit.ts), so Resume asks for one here, with the limit it
// stopped at and what it spent (as the limit counts it), then resumes with it.
export const RaiseLimitDialog: React.FC<Props> = ({ runId, onClose, onResumed }) => {
  const [info, setInfo] = useState<{ limit: number; spent: number } | null>(null)
  const [value, setValue] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!runId) return
    let alive = true
    setInfo(null); setError(null); setValue(null)
    aiAPI.getRun(runId).then(({ run, spend }) => {
      if (!alive) return
      const limit = run.spend_limit_usd ?? 0
      setInfo({ limit, spent: spend?.spent_usd ?? 0 })
      setValue(suggest(limit))
    }).catch(() => { if (alive) setError("Couldn't load the run.") })
    return () => { alive = false }
  }, [runId])

  const tooLow = !!info && value !== null && value <= info.limit
  const resume = async () => {
    if (!runId || value === null || tooLow || busy) return
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

  return (
    <Modal isOpen={!!runId} onClose={busy ? () => {} : onClose} panelClassName="max-w-md w-full"
      zClassName="z-[20010]">
      <div className="p-6 space-y-4" data-testid="ai-raise-limit">
        <h3 className="text-title text-gray-900">Raise the spend limit</h3>
        {info ? (
          <p className="text-sm text-gray-600">
            This run stopped at its {money(info.limit)} spend limit. It has spent {money(info.spent)}. To go on,
            give it a higher limit. It starts a row only while the most that row can cost still fits.
          </p>
        ) : !error && <p className="text-sm text-gray-600">Loading the run...</p>}
        {info && (
          <div className="flex items-center gap-3 text-sm">
            <span>New limit</span>
            <MoneyInput key={runId} value={value} fallback={null} label="New limit" onChange={setValue} />
          </div>
        )}
        {tooLow && <p className="text-xs text-red-600">Enter more than {money(info!.limit)}.</p>}
        {error && <p className="text-xs text-red-600" data-testid="ai-raise-limit-error">{error}</p>}
        <div className="flex justify-end space-x-3">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-primary flex items-center gap-1"
            disabled={!info || value === null || tooLow || busy} onClick={resume}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Raise and resume
          </button>
        </div>
      </div>
    </Modal>
  )
}
