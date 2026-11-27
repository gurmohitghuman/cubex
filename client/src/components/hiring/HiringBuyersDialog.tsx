import React, { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Loader2 } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { hiringAPI, type BuyerRows, type HiringBuyer, type HiringView } from '@/utils/api/hiring'
import type { ColumnRunEstimate } from '@/utils/api/column-runs'
import { ColumnRunEstimateView } from '@/components/column-runs/ColumnRunEstimateView'
import { moneyUp } from '@/lib/enrich-format'

// Find buyers (server services/hiring-buyer.ts): who to look for at each company ("Who buys?": the titles the table
// uses, or ones from its roles the first time), which companies, what it costs, then the run with that cost as its
// most. The first "Show the cost" adds the buyer columns to Companies (free: nothing runs until Find buyers); once
// they're there, the cost shows as the dialog opens. A company with no one holding the titles costs nothing.
type Shown = { e: ColumnRunEstimate; key: string }
const errorOf = (err: any, fallback: string): string => err?.response?.data?.error || fallback

export const HiringBuyersDialog: React.FC<{ v: HiringView; onClose: () => void; onChanged: () => void }> =
  ({ v, onClose, onChanged }) => {
    const [buyer, setBuyer] = useState<HiringBuyer | null>(null)
    const [titles, setTitles] = useState('')
    const [rows, setRows] = useState<BuyerRows>('empty')
    const [shown, setShown] = useState<Shown | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState<'pricing' | 'starting' | null>(null)
    const key = `${titles.trim()}|${rows}`

    const price = useCallback(async (forTitles: string, forRows: BuyerRows) => {
      setBusy('pricing')
      setError(null)
      try {
        const out = await hiringAPI.findBuyers(v.id, { titles: forTitles, rows: forRows, estimateOnly: true })
        setBuyer(out.buyer)
        if ('estimate' in out) setShown({ e: out.estimate, key: `${forTitles.trim()}|${forRows}` })
        // New columns on Companies: the grid shows them.
        if (out.saved.length) onChanged()
      } catch (err: any) {
        setError(errorOf(err, "Couldn't work out what it costs."))
      } finally {
        setBusy(null)
      }
    }, [v.id, onChanged])

    useEffect(() => {
      let live = true
      hiringAPI.buyer(v.id).then(b => {
        if (!live) return
        setBuyer(b)
        const start = (b.added ? b.titles : b.starting).join(', ')
        setTitles(start)
        // The columns are there: pricing saves nothing, so the cost shows at once.
        if (b.added) void price(start, 'empty')
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
        await hiringAPI.findBuyers(v.id, { titles, rows, estimateOnly: false, maxCostUsd: most })
        toast.success('Finding buyers. Buyer and Buyer email fill in on Companies as they are found.')
        onChanged()
        onClose()
      } catch (err: any) {
        const data = err?.response?.data
        setError(errorOf(err, "Couldn't start finding buyers."))
        // It could cost more now: show the new estimate to confirm.
        if (data?.over_ceiling && data.estimate) setShown({ e: data.estimate, key })
        setBusy(null)
      }
    }

    const e = shown?.key === key ? shown.e : null
    const nothing = !!e && e.columns.every(c => c.rows === 0)
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
                For each company on Companies, the person it would buy through: someone holding one of these titles
                there, with their LinkedIn and a work email that passed a check. One person per company.
              </p>
              <label className="block text-sm text-gray-900">
                Who buys?
                <input className="input mt-1 w-full" value={titles} onChange={ev => setTitles(ev.target.value)}
                  placeholder="Head of Sales, VP Sales" data-testid="hiring-buyers-titles" disabled={!!busy} />
                <span className="block text-xs text-gray-500 mt-1">Job titles, commas between them (at most 6).</span>
              </label>
              {buyer.added ? (
                <div className="flex gap-4 text-sm text-gray-700">
                  {([['empty', 'Companies without a buyer yet'], ['all', 'Every company again']] as const)
                    .map(([value, words]) => (
                      <label key={value} className="flex items-center gap-1.5">
                        <input type="radio" name="buyer-rows" checked={rows === value} disabled={!!busy}
                          onChange={() => setRows(value)} data-testid={`hiring-buyers-rows-${value}`} />{words}
                      </label>
                    ))}
                </div>
              ) : (
                <p className="text-xs text-gray-500">
                  Show the cost adds Buyer, Buyer title, Buyer LinkedIn and Buyer email to Companies. Nothing runs
                  until you click Find buyers.
                </p>
              )}
              {e && <ColumnRunEstimateView state={{ loading: busy === 'pricing', result: e, error: null }} />}
              {e && !nothing && (
                <p className="text-sm text-gray-900" data-testid="hiring-buyers-cost">
                  {low === high ? high : `${low} to ${high}`} from your treg balance, never more: it stops at {high}.
                  A company with no one holding these titles costs nothing.
                </p>
              )}
              {nothing && <p className="text-sm text-gray-700">Every company already has a buyer search.</p>}
              {error && <p className="text-sm text-red-600" data-testid="hiring-buyers-error">{error}</p>}
            </>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-secondary disabled:opacity-50" disabled={!!busy}
              onClick={onClose}>Cancel</button>
            {e ? (
              <button type="button" className="btn-primary disabled:opacity-50" data-testid="hiring-buyers-go"
                disabled={!!busy || nothing} onClick={() => void start(e.high_usd)}>
                {busy === 'starting' ? 'Starting…' : 'Find buyers'}</button>
            ) : (
              <button type="button" className="btn-primary disabled:opacity-50" data-testid="hiring-buyers-price"
                disabled={!!busy || !buyer || !titles.trim()} onClick={() => void price(titles, rows)}>
                {busy === 'pricing' ? 'Working it out…' : 'Show the cost'}</button>
            )}
          </div>
        </div>
      </Modal>
    )
  }
