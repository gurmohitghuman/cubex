import React, { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Loader2 } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { hiringAPI, type HiringEstimate, type HiringPlan, type HiringView } from '@/utils/api/hiring'
import { checkDay } from '@/lib/hiring'

// A check's estimate (a pure read on the server, free: only the job index's
// free count is asked), then the check when the person says so: one search
// per role title, adding only roles never found before, with the estimate's
// most as its limit. Companies is summed up when the search is done.
const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`
const plural = (n: number, w: string, ws = `${w}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? w : ws}`

export const HiringCheckDialog: React.FC<{ v: HiringView; onClose: () => void; onStarted: () => void }> =
  ({ v, onClose, onStarted }) => {
    const [shown, setShown] = useState<{ plan: HiringPlan; estimate: HiringEstimate } | null>(null)
    const [busy, setBusy] = useState(false)

    // Asked again when a check is refused for costing more than the estimate shown.
    const [asked, setAsked] = useState(0)
    useEffect(() => {
      let live = true
      hiringAPI.estimate(v.id).then(s => { if (live) setShown(s) }).catch((err: any) => {
        toast.error(err?.response?.data?.error || "Couldn't work out what a check costs.")
        if (live) onClose()
      })
      return () => { live = false }
    }, [v.id, onClose, asked])

    const check = async (most: number) => {
      setBusy(true)
      try {
        const { check: c } = await hiringAPI.check(v.id, most)
        toast.success(`Searching ${plural(c.searches, 'role title')}. Companies fills in when it's done.`)
        onStarted()
        onClose()
      } catch (err: any) {
        const data = err?.response?.data
        toast.error(data?.error || "Couldn't start the check.")
        // It could cost more now: show the new estimate to confirm.
        if (data?.over_ceiling) { setShown(null); setAsked(n => n + 1) }
        setBusy(false)
      }
    }

    const p = shown?.plan
    const e = shown?.estimate
    const where = [v.place, v.country].filter(Boolean).join(', ')
    const daily = e?.dailyLimit.remainingUsd ?? null
    const recent = v.postedWithinDays
      ? `${where ? ',' : ''} posted in the last ${plural(v.postedWithinDays, 'day')}` : ''
    return (
      <Modal isOpen onClose={() => { if (!busy) onClose() }} panelClassName="max-w-md w-full">
        <div className="p-6 space-y-3" data-testid="hiring-check-confirm">
          <h3 className="text-title text-gray-900">{p?.since ? 'Check again' : 'Check now'}</h3>
          {!p || !e ? (
            <p className="flex items-center gap-2 text-sm text-gray-600">
              <Loader2 className="h-4 w-4 animate-spin" />Working out what it costs…
            </p>
          ) : (
            <>
              <p className="text-sm text-gray-700">
                Searches {plural(e.searches, 'role title')} for roles{where ? ` in ${where}` : ''}{recent}, adding up to
                {' '}{plural(e.rolesUpTo, 'role')} to Roles ({p.perSearch} per search at most). Only roles never
                found before are added; {p.since
                  ? <>the companies with roles new since {checkDay(p.since)} show them in <b>New roles</b>.</>
                  : 'this first check finds every company new.'}
              </p>
              {e.matches && (
                <p className="text-sm text-gray-700" data-testid="hiring-check-matches">
                  {e.matches.capped ? 'At least about' : 'About'} {plural(e.matches.about, 'open role')} match
                  {e.matches.counted < e.searches
                    ? ` the first ${plural(e.matches.counted, 'search', 'searches')}` : ''}
                  {' '}(a free count; a role two searches find counts twice).
                </p>
              )}
              <p className="text-sm text-gray-900" data-testid="hiring-check-cost">
                {e.lowUsd === e.highUsd ? usd(e.highUsd) : `${usd(e.lowUsd)} to ${usd(e.highUsd)}`} from your treg
                balance, never more: the check stops at {usd(e.highUsd)}.
              </p>
              {daily !== null && daily < e.highUsd && (
                <p className="text-xs text-amber-700">
                  Your daily enrichment limit has {usd(daily)} left today: the search pauses there.
                </p>
              )}
            </>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-secondary disabled:opacity-50" disabled={busy}
              onClick={onClose}>Cancel</button>
            <button type="button" className="btn-primary disabled:opacity-50" onClick={() => e && void check(e.highUsd)}
              disabled={busy || !e || !e.priceKnown || e.searches === 0} data-testid="hiring-check-go">
              {busy ? 'Starting…' : p?.since ? 'Check again' : 'Check now'}</button>
          </div>
        </div>
      </Modal>
    )
  }
