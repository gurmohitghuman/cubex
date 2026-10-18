import React, { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Loader2 } from 'lucide-react'
import { httpAPI } from '@/utils/api'
import { waterfallAPI, type DryRow, type DryRunView } from '@/utils/api/waterfall'
import { ENRICH_RUN_POLL_MS } from '@/lib/constants'
import { formatCost } from '@/components/ai-modal/format'
import { FROM_TEXT, OUTCOME_TEXT, checkText } from './step-copy'
import { runActive } from './useWaterfall'

interface Props { runId: string; onBack: () => void }

const money = (v: number) => (v === 0 ? '$0' : formatCost(v))
const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback

const RowTrace: React.FC<{ r: DryRow }> = ({ r }) => (
  <li className="border border-gray-200 px-3 py-2 space-y-1.5" data-testid="waterfall-dry-row"
    data-answered={r.answered_by ?? ''}>
    <p className="text-xs text-gray-500">
      Row {(r.row_index + 1).toLocaleString()}: {Object.values(r.inputs).join(' · ') || 'no inputs'}
    </p>
    <p className="text-sm text-gray-900">
      {r.gone ? <span className="text-gray-500">This row was deleted.</span>
        : !r.done ? <Loader2 className="inline h-3.5 w-3.5 animate-spin text-gray-400" />
        : r.value ? <span className="font-mono break-words">{r.value}</span>
          : <span className="text-gray-500">No answer</span>}
      {r.answered_by && <span className="text-xs text-gray-500"> · by {r.answered_by}</span>}
      {r.cost_usd !== null && r.done && <span className="text-xs text-gray-500"> · {money(r.cost_usd)}</span>}
    </p>
    <ol className="space-y-0.5">
      {r.steps.map(t => (
        <li key={t.id} className="text-xs text-gray-600 break-words" data-testid="waterfall-dry-step"
          data-outcome={t.outcome}>
          {t.label}: {OUTCOME_TEXT[t.outcome]}
          {t.value ? <span className="font-mono text-gray-800"> {t.value}</span> : null}
          {t.cost_usd ? ` · ${money(t.cost_usd)}` : ''}
          {t.from ? ` · ${FROM_TEXT[t.from]}` : ''}
          {checkText(t.check)}
          {t.detail ? <span className="block text-gray-500">{t.detail}</span> : null}
        </li>
      ))}
    </ol>
  </li>
)

// A dry run as it goes and when done: each row's inputs, its answer, and every
// step it reached with what it found and what it cost. Nothing of it is in the
// sheet; a real run replays what it bought at $0 for 7 days.
export const DryRunPanel: React.FC<Props> = ({ runId, onBack }) => {
  const [view, setView] = useState<DryRunView | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const v = await waterfallAPI.dryRun(runId)
        if (!alive) return
        setView(v)
        if (!runActive(v.run)) return
      } catch (e) { if (alive) setError(errorOf(e, "Couldn't read the dry run.")) }
      if (alive) timer = setTimeout(tick, ENRICH_RUN_POLL_MS)
    }
    void tick()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [runId])

  const stop = () => httpAPI.controlRun(runId, 'cancel')
    .catch(e => toast.error(errorOf(e, "Couldn't stop the dry run.")))
  if (!view) {
    return (
      <div className="p-4 text-sm">
        {error ? <p className="text-red-700">{error}</p> : <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
      </div>
    )
  }
  const s = view.run
  const live = runActive(s)
  const what = view.only ? `Test of ${view.only.label}` : 'Dry run'
  const state = live ? 'running' : s.status === 'completed' ? 'done'
    : s.status === 'paused' ? `paused${s.message ? `: ${s.message}` : ''}` : s.status
  return (
    <div className="p-4 space-y-3 text-sm" data-testid="waterfall-dry-run" data-status={s.status}>
      <p className="text-gray-900">
        {what} on {view.rows.length.toLocaleString()} rows, {state}. Spent {money(s.spent.total_usd)}.
      </p>
      <p className="text-xs text-gray-600">Nothing is written to the sheet.</p>
      <ul className="space-y-2">{view.rows.map(r => <RowTrace key={r.row_index} r={r} />)}</ul>
      {!live && s.status === 'completed' && (
        <p className="text-xs text-gray-600">For 7 days a real run replays what this found, at $0.</p>
      )}
      <div className="flex gap-2">
        {live && <button type="button" className="btn-secondary text-red-600" onClick={stop}>Stop</button>}
        {/* A dry run left paused would hold the sheet (sorts wait): going back stops it. */}
        <button type="button" className="btn-primary" onClick={() => { if (live) void stop(); onBack() }}>
          Back to the setup
        </button>
      </div>
    </div>
  )
}
