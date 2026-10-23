import React, { useState } from 'react'
import toast from 'react-hot-toast'
import { Loader2 } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { aiVisibilityAPI, type AskEstimate, type CheckPlan } from '@/utils/api/ai-visibility'

// "Check again", weeks after the engines were asked: the plan and its cost
// first (a pure read on the server), then the check keeps the answers there
// in dated copies of the two sheets, adds the columns comparing with them, and
// asks every question again. Too soon, it says the change is mostly chance. A
// check that stopped is picked up: its copies stay, only its other engines are
// asked (or a new check starts instead, when one of them can't). While it
// starts (copies and columns first) the dialog stays open.
const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

export const CheckAgain: React.FC<{ id: string; onDone: () => void }> = ({ id, onDone }) => {
  const [shown, setShown] = useState<{ plan: CheckPlan; estimate: AskEstimate; fresh: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  const open = async (fresh = false) => {
    setBusy(true)
    try {
      setShown({ ...await aiVisibilityAPI.checkEstimate(id, fresh), fresh })
    } catch (err: any) {
      toast.error(err?.response?.data?.error || "Couldn't work out what checking again costs.")
    } finally { setBusy(false) }
  }

  const check = async () => {
    setBusy(true)
    try {
      const asking = shown?.plan.engines ?? []
      const { check: c } = await aiVisibilityAPI.check(id, shown?.fresh)
      setShown(null)
      // The engines started now (a check picked up started others before).
      const now = c.runs.filter(r => r.runId && asking.includes(r.column)).length
      if (now > 0) toast.success(`Kept the answers of ${c.label}. Asking ${plural(now, 'engine')} again.`)
      if (c.problems.length) toast.error(c.problems[0], { duration: 8000 })
      onDone()
    } catch (err: any) {
      toast.error(err?.response?.data?.error || "Couldn't check the table again.")
    } finally { setBusy(false) }
  }

  const p = shown?.plan
  const e = shown?.estimate
  return (
    <>
      <button type="button" className="btn-secondary text-xs px-3 py-1 disabled:opacity-50" disabled={busy}
        onClick={() => void open()} data-testid="ai-visibility-check">
        {busy && !shown ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Check again…'}
      </button>
      {p && e && (
        <Modal isOpen onClose={() => { if (!busy) setShown(null) }} panelClassName="max-w-md w-full">
          <div className="p-6 space-y-3" data-testid="ai-visibility-check-confirm">
            <h3 className="text-title text-gray-900">Check again</h3>
            {p.picksUp ? (
              <p className="text-sm text-gray-700">
                Picks up the check that stopped: the answers of {p.label} stay in “{p.names.questionsCopy}”, and it
                asks the {plural(e.engines.length, 'engine')} it didn’t start
                ({e.engines.map(x => x.column).join(', ')}) all {plural(p.questions, 'question')} again.
                {' '}<button type="button" className="underline disabled:opacity-50" disabled={busy}
                  onClick={() => void open(true)} data-testid="ai-visibility-check-fresh">
                  Start a new check instead</button>
              </p>
            ) : (
              <p className="text-sm text-gray-700">
                Keeps the answers of {p.label} in “{p.names.questionsCopy}”
                {p.names.sitesCopy ? <> and “{p.names.sitesCopy}”</> : null}, adds “{p.names.change}” and
                “{p.names.namedBy}” to this sheet, then asks {plural(e.engines.length, 'engine')} all
                {' '}{plural(p.questions, 'question')} again.
              </p>
            )}
            <p className="text-sm text-gray-900" data-testid="ai-visibility-check-cost">
              {e.lowUsd === e.highUsd ? usd(e.highUsd) : `${usd(e.lowUsd)} to ${usd(e.highUsd)}`} from your treg
              balance.
            </p>
            {p.soon && (
              <p className="text-xs text-amber-700" data-testid="ai-visibility-check-soon">
                {p.days === 0 ? 'These answers are from today.' : `These answers are ${plural(p.days, 'day')} old.`}
                {' '}AI answers change slowly and vary from one ask to the next, so checking again within three weeks
                mostly shows that variation.
              </p>
            )}
            <p className="text-xs text-gray-500">One question moving can be chance: read the totals.</p>
            {e.problems.map(x => <p key={x} className="text-xs text-red-600">{x}</p>)}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn-secondary disabled:opacity-50" disabled={busy}
                onClick={() => setShown(null)}>Cancel</button>
              <button type="button" className="btn-primary disabled:opacity-50" onClick={() => void check()}
                disabled={busy || e.engines.length === 0} data-testid="ai-visibility-check-go">
                {busy ? 'Keeping the answers…' : 'Check again'}</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
