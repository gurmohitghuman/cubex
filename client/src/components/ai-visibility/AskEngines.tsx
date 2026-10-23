import React, { useState } from 'react'
import toast from 'react-hot-toast'
import { Loader2 } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { aiVisibilityAPI, type AskEstimate } from '@/utils/api/ai-visibility'

// "Ask the engines": the estimate first (a pure read on the server), then one
// enrichment run per engine on the questions not asked yet, or (again) on
// every question, for fresh answers. treg bills each answer.
const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

export const AskEngines: React.FC<{ id: string; onStarted: () => void }> = ({ id, onStarted }) => {
  const [est, setEst] = useState<AskEstimate | null>(null)
  const [again, setAgain] = useState(false)
  const [busy, setBusy] = useState(false)

  const open = async (fresh: boolean) => {
    setBusy(true)
    try {
      let e = await aiVisibilityAPI.estimate(id, fresh)
      if (!fresh && e.rows === 0 && e.problems.length === 0) {
        e = await aiVisibilityAPI.estimate(id, true)
        fresh = true
      }
      setAgain(fresh)
      setEst(e)
    } catch (err: any) {
      toast.error(err?.response?.data?.error || "Couldn't work out what asking costs.")
    } finally { setBusy(false) }
  }

  const ask = async () => {
    setBusy(true)
    try {
      const r = await aiVisibilityAPI.ask(id, again)
      setEst(null)
      if (r.started.length) toast.success(`Asking ${plural(r.started.length, 'engine')}. Answers fill in as they come.`)
      if (r.problems.length) toast.error(r.problems[0])
      onStarted()
    } catch (err: any) {
      toast.error(err?.response?.data?.error || "Couldn't ask the engines.")
    } finally { setBusy(false) }
  }

  return (
    <>
      <button type="button" className="btn-primary text-xs px-3 py-1 disabled:opacity-50" disabled={busy}
        onClick={() => void open(false)} data-testid="ai-visibility-ask">
        {busy && !est ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Ask the engines…'}
      </button>
      {est && (
        <Modal isOpen onClose={() => setEst(null)} panelClassName="max-w-md w-full">
          <div className="p-6 space-y-3" data-testid="ai-visibility-ask-confirm">
            <h3 className="text-title text-gray-900">{again ? 'Ask every question again' : 'Ask the engines'}</h3>
            <p className="text-sm text-gray-700">
              {again ? 'Every question has an answer. Asking again gets fresh answers for all of them: '
                : `${plural(est.rows, 'question')} not asked yet, `}
              {plural(est.engines.length, 'engine')}: {est.engines.map(e => e.column).join(', ')}.
            </p>
            <p className="text-sm text-gray-900" data-testid="ai-visibility-cost">
              {est.lowUsd === est.highUsd ? usd(est.highUsd) : `${usd(est.lowUsd)} to ${usd(est.highUsd)}`} from
              your treg balance.
            </p>
            {est.problems.map(p => <p key={p} className="text-xs text-red-600">{p}</p>)}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn-secondary" onClick={() => setEst(null)}>Cancel</button>
              <button type="button" className="btn-primary disabled:opacity-50" onClick={() => void ask()}
                disabled={busy || est.engines.length === 0 || (est.rows === 0 && !again)}
                data-testid="ai-visibility-ask-go">{busy ? 'Starting…' : 'Ask'}</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
