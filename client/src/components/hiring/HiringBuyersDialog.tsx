import React, { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { Loader2 } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { hiringAPI, type HiringBuyer, type HiringView } from '@/utils/api/hiring'
import type { ColumnRunEstimate } from '@/utils/api/column-runs'
import { ColumnRunEstimateView } from '@/components/column-runs/ColumnRunEstimateView'
import { moneyUp } from '@/lib/enrich-format'

// Find buyers (server services/hiring-buyer.ts): who to look for at each company without a buyer yet ("Who buys?":
// the titles the table uses, or ones from its roles the first time), what it costs, then the run with that cost as
// its most. The cost is a pure read, so it shows as the dialog opens; it doesn't depend on the titles (one person a
// company whatever they are), so editing them keeps it. Only Find buyers adds the columns to Companies.
const errorOf = (err: any, fallback: string): string => err?.response?.data?.error || fallback
const ADDS = 'Buyer search, Buyer, Buyer title, Buyer LinkedIn, Buyer email search, Buyer email and Buyer email status'

export const HiringBuyersDialog: React.FC<{ v: HiringView; onClose: () => void; onChanged: () => void }> =
  ({ v, onClose, onChanged }) => {
    const [buyer, setBuyer] = useState<HiringBuyer | null>(null)
    const [titles, setTitles] = useState('')
    const [e, setEstimate] = useState<ColumnRunEstimate | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState<'pricing' | 'starting' | null>(null)
    // The page passes a new onChanged each render: read through a ref, so a reload never reopens the dialog's reads.
    const changed = useRef(onChanged)
    changed.current = onChanged

    const price = useCallback(async (forTitles: string) => {
      setBusy('pricing')
      setError(null)
      try {
        const out = await hiringAPI.findBuyers(v.id, { titles: forTitles, estimateOnly: true })
        if ('estimate' in out) setEstimate(out.estimate)
      } catch (err: any) {
        setError(errorOf(err, "Couldn't work out what it costs."))
      } finally {
        setBusy(null)
      }
    }, [v.id])

    useEffect(() => {
      let live = true
      hiringAPI.buyer(v.id).then(b => {
        if (!live) return
        setBuyer(b)
        const start = (b.added ? b.titles : b.starting).join(', ')
        setTitles(start)
        if (start) void price(start)
      }).catch((err: any) => {
        toast.error(errorOf(err, "Couldn't read the hiring table."))
        if (live) onClose()
      })
      return () => { live = false }
    }, [v.id, onClose, price])

    const start = async (most: number) => {
      setBusy('starting')
      setError(null)
      try {
        await hiringAPI.findBuyers(v.id, { titles, estimateOnly: false, maxCostUsd: most })
        toast.success('Finding buyers. Buyer and Buyer email fill in on Companies as they are found.')
        changed.current()
        onClose()
      } catch (err: any) {
        const data = err?.response?.data
        setError(errorOf(err, "Couldn't start finding buyers."))
        // It could cost more now: show the new estimate to confirm.
        if (data?.over_ceiling && data.estimate) setEstimate(data.estimate)
        setBusy(null)
      }
    }

    const [low, high] = e ? [moneyUp(e.low_usd), moneyUp(e.high_usd)] : ['', '']
    return (
      <Modal isOpen onClose={() => { if (!busy) onClose() }} panelClassName="max-w-lg w-full">
        <div className="p-6 space-y-3" data-testid="hiring-buyers">
          <h3 className="text-title text-gray-900">Find buyers</h3>
          {!buyer ? (
            <p className="flex items-center gap-2 text-sm text-gray-600">
              <Loader2 className="h-4 w-4 animate-spin" />Reading the table…
            </p>
          ) : (
            <>
              <p className="text-sm text-gray-700">
                For each company on Companies without a buyer yet, the person it would buy through: someone holding
                one of these titles there, with their LinkedIn and a work email that passed a check. One person per
                company.
              </p>
              <label className="block text-sm text-gray-900">
                Who buys?
                <input className="input mt-1 w-full" value={titles} onChange={ev => setTitles(ev.target.value)}
                  placeholder="Head of Sales, VP Sales" data-testid="hiring-buyers-titles" disabled={!!busy} />
                <span className="block text-xs text-gray-500 mt-1">Job titles, commas between them (at most 6).</span>
              </label>
              {!buyer.added && <p className="text-xs text-gray-500">Find buyers adds {ADDS} to Companies.</p>}
              {e && <ColumnRunEstimateView state={{ loading: busy === 'pricing', result: e, error: null }} />}
              {e && (
                <p className="text-sm text-gray-900" data-testid="hiring-buyers-cost">
                  {low === high ? high : `${low} to ${high}`} from your treg balance, never more: it stops at {high}.
                  A company with no one holding these titles costs nothing.
                </p>
              )}
              {error && <p className="text-sm text-red-600" data-testid="hiring-buyers-error">{error}</p>}
            </>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-secondary disabled:opacity-50" disabled={!!busy}
              onClick={onClose}>Cancel</button>
            {e ? (
              <button type="button" className="btn-primary disabled:opacity-50" data-testid="hiring-buyers-go"
                disabled={!!busy || !titles.trim()} onClick={() => void start(e.high_usd)}>
                {busy === 'starting' ? 'Starting…' : 'Find buyers'}</button>
            ) : (
              <button type="button" className="btn-primary disabled:opacity-50" data-testid="hiring-buyers-price"
                disabled={!!busy || !buyer || !titles.trim()} onClick={() => void price(titles)}>
                {busy === 'pricing' ? 'Working it out…' : 'Show the cost'}</button>
            )}
          </div>
        </div>
      </Modal>
    )
  }
