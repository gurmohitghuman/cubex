import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Loader2, Megaphone } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { socialAPI, type SocialPlatform, type SocialPlatformOption, type SocialStep } from '@/utils/api/social'

// "Research social posts": a new table of the posts on a topic, on the platforms
// you tick, with the steps you tick set up on each post and not run. Making it
// searches nothing and costs nothing: the table opens on what finding the
// posts costs, which runs when you say so. Platforms are the ones treg serves now.
interface Props { isOpen: boolean; onClose: () => void }

type StepWords = { label: string; hint: string; price: (o: SocialPlatformOption) => number | null }
const STEP_WORDS: Record<SocialStep, StepWords> = {
  transcript: { label: 'Transcript', hint: 'What is said in each video.', price: o => o.steps.transcript },
  breakdown: { label: 'Why it works', hint: 'AI: the hook, what keeps people watching, the payoff. Your AI model\'s '
    + 'price.', price: () => null },
  creator: { label: 'Creator', hint: 'Followers and bio (TikTok and X searches give the followers already).',
    price: o => o.steps.creator },
  comments: { label: 'Comments', hint: 'Into a Comments sheet, each tagged by AI: compares, asks, hates, loves.',
    price: o => o.steps.comments },
}
const DAYS = [7, 30, 90]
const money = (usd: number) => (usd < 0.01 ? `$${usd.toPrecision(2).replace(/0+$/, '')}` : `$${usd.toFixed(2)}`)

export const SocialDialog: React.FC<Props> = ({ isOpen, onClose }) => {
  const navigate = useNavigate()
  const [options, setOptions] = useState<SocialPlatformOption[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [topic, setTopic] = useState('')
  const [platforms, setPlatforms] = useState<SocialPlatform[]>([])
  const [steps, setSteps] = useState<SocialStep[]>([])
  const [minViews, setMinViews] = useState('')
  const [days, setDays] = useState<number | null>(30)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    socialAPI.options().then(setOptions)
      .catch(e => setLoadError(e?.response?.data?.error || "Can't reach treg's catalog right now."))
  }, [isOpen])

  const toggle = <T,>(list: T[], set: (v: T[]) => void, v: T) => set(list.includes(v) ? list.filter(x => x !== v)
    : [...list, v])
  const views = minViews.trim() === '' ? null : Number(minViews)
  const problem = !topic.trim() ? 'Say what to research.'
    : platforms.length === 0 ? 'Tick at least one platform.'
    : views !== null && !(Number.isInteger(views) && views >= 0) ? 'At least N views: a whole number.' : null
  const chosen = (options ?? []).filter(o => platforms.includes(o.platform))
  const most = (s: SocialStep) => {
    const prices = chosen.map(STEP_WORDS[s].price).filter((p): p is number => typeof p === 'number' && p > 0)
    return prices.length ? Math.max(...prices) : null
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (problem || busy) return
    setBusy(true)
    try {
      const made = await socialAPI.create({ topic: topic.trim(), platforms, steps, minViews: views,
        postedWithinDays: days })
      onClose()
      // The table opens on what finding its posts costs.
      navigate(`/table/${made.id}/${made.sheetId}`, { state: { socialFind: made.social.id } })
    } catch (err: any) {
      toast.error(err?.response?.data?.error || "Couldn't make the table.")
      setBusy(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} panelClassName="max-w-lg w-full">
      <form onSubmit={submit} data-testid="social-dialog">
        <div className="p-6 border-b border-gray-200 flex items-center gap-3">
          <div className="w-10 h-10 bg-cube-black flex items-center justify-center">
            <Megaphone className="h-5 w-5 text-white" />
          </div>
          <div>
            <h3 className="text-title text-gray-900">Research social posts</h3>
            <p className="text-xs text-gray-500">The posts on a topic that did well, why they work, and who made
              them. Nothing is searched until you say so.</p>
          </div>
        </div>
        <div className="p-6 space-y-4 max-h-[65vh] overflow-y-auto">
          <Field label="Topic">
            <input className="input w-full" value={topic} onChange={e => setTopic(e.target.value)} autoFocus
              aria-label="Topic" placeholder="morning routine" maxLength={100} />
          </Field>
          <Field label="Platforms">
            {loadError ? <p className="text-sm text-red-600">{loadError}</p>
              : !options ? <p className="text-sm text-gray-500">Reading what treg serves…</p>
              : (
                <div className="flex flex-wrap gap-x-5 gap-y-1">
                  {options.map(o => (
                    <label key={o.platform} className="flex items-center gap-1.5 text-sm text-gray-800">
                      <input type="checkbox" className="border-gray-300 text-cube-black focus:ring-black"
                        checked={platforms.includes(o.platform)} aria-label={o.label}
                        onChange={() => toggle(platforms, setPlatforms, o.platform)} />
                      {o.label}
                      {o.searchUsd !== null
                        && <span className="text-xs text-gray-500">{money(o.searchUsd)} a search</span>}
                    </label>
                  ))}
                </div>
              )}
          </Field>
          <Field label="Add to each post (optional)" hint="Set up, not run: run each on the posts you pick, with its
            cost shown first.">
            <div className="space-y-1.5">
              {(Object.keys(STEP_WORDS) as SocialStep[]).map(s => (
                <label key={s} className="flex items-start gap-2 text-sm text-gray-800">
                  <input type="checkbox" className="mt-0.5 border-gray-300 text-cube-black focus:ring-black"
                    checked={steps.includes(s)} aria-label={STEP_WORDS[s].label}
                    onChange={() => toggle(steps, setSteps, s)} />
                  <span>
                    {STEP_WORDS[s].label}
                    {most(s) !== null
                      && <span className="text-xs text-gray-500"> · up to {money(most(s)!)} a post</span>}
                    <span className="block text-xs text-gray-500">{STEP_WORDS[s].hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Top posts: at least" hint="Views. Empty: any.">
              <input className="input w-full" inputMode="numeric" value={minViews} placeholder="10000"
                onChange={e => setMinViews(e.target.value)} aria-label="At least this many views" />
            </Field>
            <Field label="Posted within">
              <select className="input w-full" value={days ?? ''} aria-label="Posted within"
                onChange={e => setDays(e.target.value ? Number(e.target.value) : null)}>
                {DAYS.map(d => <option key={d} value={d}>{d} days</option>)}
                <option value="">Any time</option>
              </select>
            </Field>
          </div>
        </div>
        <div className="p-6 pt-0 flex items-center gap-3">
          <span className="text-xs text-gray-500 flex-1">{problem ?? 'Making the table costs nothing.'}</span>
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={!!problem || busy} className="btn-primary disabled:opacity-50"
            data-testid="social-create">
            {busy
              ? <span className="flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" />Making…</span>
              : 'Make the table'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div>
    <div className="text-sm font-medium text-gray-900 mb-1">{label}</div>
    {children}
    {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
  </div>
)

// The way in: a button that opens the dialog (the dashboard, the New Table dialog).
export const SocialButton: React.FC<{ className?: string }> = ({ className = '' }) => {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} data-testid="social-open"
        className={`btn-secondary flex items-center justify-center gap-2 text-sm px-4 py-2 ${className}`}>
        <Megaphone className="h-4 w-4" /><span>Research social posts</span>
      </button>
      {open && <SocialDialog isOpen={open} onClose={() => setOpen(false)} />}
    </>
  )
}
