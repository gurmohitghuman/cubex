import React, { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Loader2 } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { socialAPI, type FindEstimate, type SocialView } from '@/utils/api/social'
import { moneyUp } from '@/lib/enrich-format'

// Find posts: what it costs first (a pure read, free), then each platform's search on every row of Searches when
// the person says so, adding only posts never found before, with the estimate's most as its limit. The cost is
// shown rounded up, so the most never reads as less than it is.
const plural = (n: number, w: string, ws = `${w}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? w : ws}`
const LABELS: Record<string, string> = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', x: 'X' }

export const FindPostsDialog: React.FC<{ v: SocialView; onClose: () => void; onStarted: () => void }> =
  ({ v, onClose, onStarted }) => {
    const [e, setE] = useState<FindEstimate | null>(null)
    const [busy, setBusy] = useState(false)
    // Asked again when the start is refused for costing more than the estimate shown.
    const [asked, setAsked] = useState(0)
    useEffect(() => {
      let live = true
      socialAPI.estimate(v.id).then(x => { if (live) setE(x) }).catch((err: any) => {
        toast.error(err?.response?.data?.error || "Couldn't work out what finding posts costs.")
        if (live) onClose()
      })
      return () => { live = false }
    }, [v.id, onClose, asked])

    const find = async (most: number) => {
      setBusy(true)
      try {
        const out = await socialAPI.find(v.id, most)
        const where = out.runs.map(r => LABELS[r.platform]).join(', ')
        toast.success(`Finding posts on ${where}. They fill in as they come.`)
        onStarted()
        onClose()
      } catch (err: any) {
        const data = err?.response?.data
        toast.error(data?.error || "Couldn't start finding posts.")
        if (data?.over_ceiling) { setE(null); setAsked(n => n + 1) }
        setBusy(false)
      }
    }

    const [low, high] = e ? [moneyUp(e.lowUsd), moneyUp(e.highUsd)] : ['', '']
    return (
      <Modal isOpen onClose={() => { if (!busy) onClose() }} panelClassName="max-w-md w-full">
        <div className="p-6 space-y-3" data-testid="social-find-confirm">
          <h3 className="text-title text-gray-900">Find posts</h3>
          {!e ? (
            <p className="flex items-center gap-2 text-sm text-gray-600">
              <Loader2 className="h-4 w-4 animate-spin" />Working out what it costs…
            </p>
          ) : (
            <>
              <p className="text-sm text-gray-700">
                Searches {plural(e.searches, 'search', 'searches')} on {e.platforms.map(p => LABELS[p.platform])
                  .join(', ')}, adding up to {plural(e.postsUpTo, 'post')}. Only posts never found before are added,
                so running it again later finds what's new.
              </p>
              <p className="text-sm text-gray-900" data-testid="social-find-cost">
                {low === high ? high : `${low} to ${high}`} from your treg balance, never more: it stops at {high}.
              </p>
            </>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-secondary disabled:opacity-50" disabled={busy}
              onClick={onClose}>Cancel</button>
            <button type="button" className="btn-primary disabled:opacity-50" onClick={() => e && void find(e.highUsd)}
              disabled={busy || !e || !e.priceKnown || e.searches === 0} data-testid="social-find-go">
              {busy ? 'Starting…' : 'Find posts'}</button>
          </div>
        </div>
      </Modal>
    )
  }
