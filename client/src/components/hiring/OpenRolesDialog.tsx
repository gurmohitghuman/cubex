// Over 200 lines: one dialog, the ask's fields, its estimate and the start, sharing their state.
import React, { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { Briefcase, Loader2 } from 'lucide-react'
import { Modal } from '@/components/Modal'
import {
  openRolesAPI, type OpenRolesEstimate, type OpenRolesOptions, type OpenRolesStarted,
} from '@/utils/api/open-roles'
import { linesOf } from '@/lib/ai-visibility'
import { guessDedupeMatch } from '@/lib/dedupe'
import { moneyUp } from '@/lib/enrich-format'
import {
  HIRING_DEFAULT_POSTED_DAYS, HIRING_MAX_PER_SEARCH, HIRING_MAX_ROLES, HIRING_POSTED_CHOICES,
} from '@/lib/hiring'

// "Open roles at these companies": the same hiring signal on a sheet of companies the person already has. Each
// company row is searched by its website; each role found goes into an Open roles sheet beside it, and a column on
// the sheet counts each company's roles. The cost first (free: only the job index's free count is
// asked), then the run when the person says so, never spending more than that. A sheet searched before opens with
// what it was last run with: running it again adds only roles not seen before.
interface Props {
  sheetId: string
  columns: string[]
  onClose: () => void
  onStarted: (started: OpenRolesStarted) => void
}

const DEFAULT_PER_COMPANY = 10
const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`
const plural = (n: number, w: string, ws = `${w}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? w : ws}`
// The column that looks like each company's website, else the first.
const websiteGuess = (columns: string[]) => columns.find(c => guessDedupeMatch(c) === 'domain') ?? columns[0] ?? ''

export const OpenRolesDialog: React.FC<Props> = ({ sheetId, columns, onClose, onStarted }) => {
  const [loaded, setLoaded] = useState(false)
  const [again, setAgain] = useState(false)
  const [website, setWebsite] = useState(() => websiteGuess(columns))
  const [roles, setRoles] = useState('')
  const [country, setCountry] = useState('US')
  const [place, setPlace] = useState('')
  const [days, setDays] = useState<number | null>(HIRING_DEFAULT_POSTED_DAYS)
  const [perCompany, setPerCompany] = useState(String(DEFAULT_PER_COMPANY))
  const [estimate, setEstimate] = useState<OpenRolesEstimate | null>(null)
  const [busy, setBusy] = useState(false)

  // What it was last run with, when it was: read once as the dialog opens (the sheet's columns are a new list at
  // each refresh, which must not put it back over what the person changed since).
  const columnsNow = useRef(columns)
  columnsNow.current = columns
  useEffect(() => {
    let live = true
    openRolesAPI.setup(sheetId).then(s => {
      if (!live) return
      const o = s?.options
      if (o) {
        setAgain(true)
        if (columnsNow.current.includes(o.websiteColumn)) setWebsite(o.websiteColumn)
        setRoles(o.roles.join('\n'))
        setCountry(o.country ?? '')
        setPlace(o.place ?? '')
        setDays(o.postedWithinDays)
        setPerCompany(String(o.perCompany))
      }
      setLoaded(true)
    }).catch(() => { if (live) setLoaded(true) })
    return () => { live = false }
  }, [sheetId])

  // Once each, as first written (the server takes them the same way).
  const titles = linesOf(roles).filter((r, i, all) => all.findIndex(x => x.toLowerCase() === r.toLowerCase()) === i)
  const per = Number(perCompany)
  const problem = !website ? 'Pick the column with each company\'s website.'
    : titles.length === 0 ? 'Add at least one role title.'
    : titles.length > HIRING_MAX_ROLES ? `At most ${HIRING_MAX_ROLES} role titles.`
    : country.trim() && !/^[A-Za-z]{2}$/.test(country.trim()) ? 'The country is two letters, such as US or GB.'
    : !Number.isInteger(per) || per < 1 || per > HIRING_MAX_PER_SEARCH
      ? `Roles per company: 1 to ${HIRING_MAX_PER_SEARCH}.` : null
  const options = (): OpenRolesOptions => ({
    websiteColumn: website, roles: titles, country: country.trim().toUpperCase() || null, place: place.trim() || null,
    postedWithinDays: days, perCompany: per,
  })

  const askCost = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (problem || busy) return
    setBusy(true)
    try { setEstimate(await openRolesAPI.estimate(sheetId, options())) } catch (err: any) {
      toast.error(err?.response?.data?.error || "Couldn't work out what it costs.")
    }
    setBusy(false)
  }

  const start = async (most: number) => {
    setBusy(true)
    try {
      const started = await openRolesAPI.start(sheetId, options(), most)
      toast.success(`Looking for open roles. They go into the ${started.rolesSheetName} sheet as they're found.`)
      onStarted(started)
      onClose()
    } catch (err: any) {
      const data = err?.response?.data
      toast.error(data?.error || "Couldn't start the search.")
      // It could cost more now: show the new estimate to confirm.
      if (data?.over_ceiling && data.estimate) setEstimate(data.estimate)
      setBusy(false)
    }
  }

  const e = estimate
  const [low, high] = e ? [moneyUp(e.lowUsd), moneyUp(e.highUsd)] : ['', '']
  const daily = e?.dailyLimit.remainingUsd ?? null
  return (
    <Modal isOpen onClose={() => { if (!busy) onClose() }} panelClassName="max-w-lg w-full">
      <form onSubmit={askCost} data-testid="open-roles-dialog">
        <div className="p-6 border-b border-gray-200 flex items-center gap-3">
          <div className="w-10 h-10 bg-cube-black flex items-center justify-center">
            <Briefcase className="h-5 w-5 text-white" />
          </div>
          <div>
            <h3 className="text-title text-gray-900">Open roles at these companies</h3>
            <p className="text-xs text-gray-500">Which of these companies are hiring for the roles you name. Each
              role goes into an Open roles sheet beside this one.</p>
          </div>
        </div>
        {!loaded ? (
          <p className="p-6 flex items-center gap-2 text-sm text-gray-600">
            <Loader2 className="h-4 w-4 animate-spin" />Loading…
          </p>
        ) : e ? (
          <div className="p-6 space-y-3" data-testid="open-roles-estimate">
            <p className="text-sm text-gray-700">
              Looks for {plural(titles.length, 'role title')} at {plural(e.companies, 'company', 'companies')}
              {' '}(a row with no website is skipped, and costs nothing), adding up to {plural(e.rolesUpTo, 'role')} to
              the Open roles sheet, {per} per company at most. Only roles not found before are added.
            </p>
            {e.matches && (
              <p className="text-sm text-gray-700" data-testid="open-roles-matches">
                {e.matches.capped ? 'At least about' : 'About'} {plural(e.matches.about, 'open role')} match at
                {e.matches.counted < e.matches.asked ? ` ${e.matches.counted} of` : ''} the first
                {' '}{plural(e.matches.asked, 'company', 'companies')} with a website (a free count).
              </p>
            )}
            <p className="text-sm text-gray-900" data-testid="open-roles-cost">
              {low === high ? high : `${low} to ${high}`} from your treg balance, never more: the search stops
              at {high}.
            </p>
            {daily !== null && daily < e.highUsd && (
              <p className="text-xs text-amber-700">
                Your daily enrichment limit has {usd(daily)} left today: the search pauses there.
              </p>
            )}
          </div>
        ) : (
          <div className="p-6 space-y-4 max-h-[65vh] overflow-y-auto">
            <Field label="Website column" hint="Each company's website or domain, such as ramp.com.">
              <select className="input w-full" value={website} onChange={ev => setWebsite(ev.target.value)}
                aria-label="Website column">
                {columns.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Role titles" hint="One per line, as job posts name them: “SDR”, “Head of RevOps”.">
              <textarea className="input w-full h-24" value={roles} onChange={ev => setRoles(ev.target.value)}
                autoFocus aria-label="Role titles" placeholder={'Sales Development Representative\nRevOps Manager'} />
            </Field>
            <div className="grid grid-cols-[6rem_1fr] gap-3">
              <Field label="Country" hint="Empty: any.">
                <input className="input w-full" value={country} maxLength={2} aria-label="Country"
                  onChange={ev => setCountry(ev.target.value)} />
              </Field>
              <Field label="City or region (optional)">
                <input className="input w-full" value={place} onChange={ev => setPlace(ev.target.value)}
                  aria-label="City or region" placeholder="Texas" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Posted within">
                <select className="input w-full" value={days ?? ''} aria-label="Posted within"
                  onChange={ev => setDays(ev.target.value ? Number(ev.target.value) : null)}>
                  {HIRING_POSTED_CHOICES.map(d => <option key={d} value={d}>{d} days</option>)}
                  {days !== null && !(HIRING_POSTED_CHOICES as readonly number[]).includes(days)
                    && <option value={days}>{days} days</option>}
                  <option value="">Any time</option>
                </select>
              </Field>
              <Field label="Roles per company" hint={`At most ${HIRING_MAX_PER_SEARCH}: the cost goes with it.`}>
                <input className="input w-full" type="number" min={1} max={HIRING_MAX_PER_SEARCH} value={perCompany}
                  onChange={ev => setPerCompany(ev.target.value)} aria-label="Roles per company" />
              </Field>
            </div>
            <p className="text-xs text-gray-500">
              {again ? 'Searched before: running it again adds only roles not found before.'
                : 'Nothing is searched yet: the next step shows what it costs (treg bills each role found).'}
            </p>
          </div>
        )}
        <div className="p-6 pt-0 flex items-center gap-3">
          <span className="text-xs text-gray-500 flex-1">{!e && loaded ? problem ?? '' : ''}</span>
          {e ? (
            <>
              <button type="button" className="btn-secondary disabled:opacity-50" disabled={busy}
                onClick={() => setEstimate(null)}>Back</button>
              <button type="button" className="btn-primary disabled:opacity-50" data-testid="open-roles-go"
                disabled={busy || !e.priceKnown || e.companies === 0} onClick={() => void start(e.highUsd)}>
                {busy ? 'Starting…' : 'Find open roles'}</button>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
              <button type="submit" disabled={!loaded || !!problem || busy} className="btn-primary disabled:opacity-50"
                data-testid="open-roles-cost-step">
                {busy ? <span className="flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" />Working
                  out the cost…</span> : 'See the cost'}
              </button>
            </>
          )}
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
