import React, { useState } from 'react'
import toast from 'react-hot-toast'
import { Loader2 } from 'lucide-react'
import { httpAPI } from '@/utils/api'
import { waterfallAPI, type WaterfallRunStatus } from '@/utils/api/waterfall'
import { formatCost } from '@/components/ai-modal/format'
import { MoneyInput } from '@/components/enrich-modal/MoneyInput'
import { runActive } from './useWaterfall'

interface Props { status: WaterfallRunStatus | null; onChanged: () => void; onDone: () => void }

const money = (v: number) => (v === 0 ? '$0' : formatCost(v))
const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback
const cents = (n: number) => Math.ceil(n * 100 - 1e-9) / 100

// A run that stopped at its limit: "Raise to $[x] and resume". It suggests
// enough for the rows still to run at their most, and the new limit must
// leave room for one more row, or the run pauses again at once. With no price
// for a row (its steps bill your own keys) it must be more than what's spent.
const RaiseAndResume: React.FC<{ s: WaterfallRunStatus; busy: boolean; onRaise: (v: number) => void }> = (
  { s, busy, onRaise },
) => {
  const spent = s.spent.total_usd
  const perRow = s.max_per_row_usd
  const least = cents(spent + (perRow > 0 ? perRow : 0.01))
  const suggest = perRow > 0 ? cents(spent + Math.max(1, s.total_rows - s.processed_rows) * perRow)
    : cents(Math.max(spent * 2, spent + 1))
  const [value, setValue] = useState<number | null>(suggest)
  const short = value !== null && value + 1e-9 < least
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span>Raise the run limit to</span>
        <MoneyInput value={suggest} fallback={null} label="New run limit" onChange={setValue} />
        <button type="button" className="btn-primary" disabled={busy || value === null || short}
          onClick={() => value !== null && onRaise(value)} data-testid="waterfall-raise-resume">
          Raise and resume
        </button>
      </div>
      {short && (
        <p className="text-xs text-gray-600">
          {perRow > 0 ? `A row can cost up to ${money(perRow)}, so it` : 'It'} needs at least {money(least)} to
          run another row.
        </p>
      )}
    </div>
  )
}

// A waterfall run as it goes: rows done, what it spent (treg and AI), and per
// step how many rows reached it and how many it answered. Pause, resume and
// stop are the HTTP run controls.
export const RunProgress: React.FC<Props> = ({ status: s, onChanged, onDone }) => {
  const [busy, setBusy] = useState(false)
  if (!s) return <div className="p-4"><Loader2 className="h-4 w-4 animate-spin text-gray-400" /></div>
  const control = (action: 'pause' | 'resume' | 'cancel') => {
    setBusy(true)
    httpAPI.controlRun(s.id, action).then(onChanged)
      .catch(e => toast.error(errorOf(e, "Couldn't change the run.")))
      .finally(() => setBusy(false))
  }
  const raise = (limit: number) => {
    setBusy(true)
    waterfallAPI.resume(s.id, limit).then(onChanged)
      .catch(e => toast.error(errorOf(e, "Couldn't resume the run.")))
      .finally(() => setBusy(false))
  }
  const live = runActive(s)
  // Resumed as it is, a run at its limit would pause again at once.
  const atLimit = s.status === 'paused' && s.pause_reason === 'spend_limit'
  const words = s.starting ? 'Starting…' : s.status === 'paused' ? `Paused${s.message ? `: ${s.message}` : ''}`
    : s.status === 'running' || s.status === 'pending' ? 'Running'
      : s.status === 'completed' ? 'Finished' : s.status === 'failed' ? `Failed${s.message ? `: ${s.message}` : ''}`
        : 'Stopped'
  return (
    <div className="p-4 space-y-3 text-sm" data-testid="waterfall-run" data-status={s.status}>
      <p className="text-gray-900">{words}</p>
      <p className="text-gray-700">
        {s.processed_rows.toLocaleString()} of {s.total_rows.toLocaleString()} rows
        {s.skipped_rows > 0 ? ` (${s.skipped_rows.toLocaleString()} had no inputs for any step)` : ''}.
        Spent {money(s.spent.total_usd)}{s.spent.ai_usd > 0 ? ` (AI ${money(s.spent.ai_usd)})` : ''}
        {s.run_limit_usd !== null ? ` of its ${money(s.run_limit_usd)} limit` : ''}.
      </p>
      <table className="w-full text-xs">
        <thead><tr className="text-gray-500"><th className="text-left font-normal">Step</th>
          <th className="text-right font-normal">Reached</th><th className="text-right font-normal">Answered</th>
          <th className="text-right font-normal">Failed</th>
          <th className="text-right font-normal">Cost</th></tr></thead>
        <tbody>
          {s.steps.map(st => (
            <tr key={st.id} className={st.on ? '' : 'text-gray-400'} data-testid="waterfall-run-step">
              <td className="truncate max-w-[10rem]">{st.label}</td>
              <td className="text-right">{st.reached.toLocaleString()}</td>
              <td className="text-right">{st.answered.toLocaleString()}</td>
              <td className="text-right">{st.failed.toLocaleString()}</td>
              <td className="text-right">{money(st.cost_usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {atLimit && <RaiseAndResume s={s} busy={busy} onRaise={raise} />}
      <div className="flex gap-2">
        {live && s.status !== 'paused' && !s.starting && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => control('pause')}>
            Pause
          </button>
        )}
        {s.status === 'paused' && !atLimit && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => control('resume')}>
            Resume
          </button>
        )}
        {live && (
          <button type="button" className="btn-secondary text-red-600" disabled={busy}
            onClick={() => control('cancel')}>
            Stop
          </button>
        )}
        {!live && <button type="button" className="btn-primary" onClick={onDone}>Done</button>}
      </div>
    </div>
  )
}
