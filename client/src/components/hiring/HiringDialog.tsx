import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Briefcase, Loader2 } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { hiringAPI } from '@/utils/api/hiring'
import { linesOf } from '@/lib/ai-visibility'
import { HiringMoreOptions, NO_HIRING_OPTIONS } from './HiringMoreOptions'
import {
  HIRING_DEFAULT_PER_SEARCH, HIRING_DEFAULT_POSTED_DAYS, HIRING_MAX_PER_SEARCH, HIRING_MAX_ROLES,
  HIRING_POSTED_CHOICES,
} from '@/lib/hiring'

// "Find companies hiring": a new table of the companies hiring for the roles
// you name, a buying signal. Making it searches nothing and costs nothing: the
// table opens on the estimate of its first check, which runs when you say so.
interface Props { isOpen: boolean; onClose: () => void }

export const HiringDialog: React.FC<Props> = ({ isOpen, onClose }) => {
  const navigate = useNavigate()
  const [roles, setRoles] = useState('')
  const [country, setCountry] = useState('US')
  const [place, setPlace] = useState('')
  const [days, setDays] = useState<number | null>(HIRING_DEFAULT_POSTED_DAYS)
  const [perSearch, setPerSearch] = useState(String(HIRING_DEFAULT_PER_SEARCH))
  const [options, setOptions] = useState(NO_HIRING_OPTIONS)
  const [busy, setBusy] = useState(false)
  // Once each, as first written (the server takes them the same way).
  const titles = linesOf(roles).filter((r, i, all) => all.findIndex(x => x.toLowerCase() === r.toLowerCase()) === i)
  const per = Number(perSearch)
  const problem = titles.length === 0 ? 'Add at least one role title.'
    : titles.length > HIRING_MAX_ROLES ? `Start with at most ${HIRING_MAX_ROLES} role titles.`
    : country.trim() && !/^[A-Za-z]{2}$/.test(country.trim()) ? 'The country is two letters, such as US or GB.'
    : !Number.isInteger(per) || per < 1 || per > HIRING_MAX_PER_SEARCH
      ? `Roles per search: 1 to ${HIRING_MAX_PER_SEARCH}.` : null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (problem || busy) return
    setBusy(true)
    try {
      const made = await hiringAPI.create({
        roles: titles, country: country.trim().toUpperCase(), place: place.trim(), postedWithinDays: days,
        perSearch: per, ...options,
      })
      onClose()
      // The table opens on its first check's estimate.
      navigate(`/table/${made.id}/${made.sheetId}`, { state: { hiringEstimate: made.hiring.id } })
    } catch (err: any) {
      toast.error(err?.response?.data?.error || "Couldn't make the table.")
      setBusy(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} panelClassName="max-w-lg w-full">
      <form onSubmit={submit} data-testid="hiring-dialog">
        <div className="p-6 border-b border-gray-200 flex items-center gap-3">
          <div className="w-10 h-10 bg-cube-black flex items-center justify-center">
            <Briefcase className="h-5 w-5 text-white" />
          </div>
          <div>
            <h3 className="text-title text-gray-900">Find companies hiring</h3>
            <p className="text-xs text-gray-500">A company hiring for a role often needs what you sell. A table
              of who is hiring, and what's new at each check.</p>
          </div>
        </div>
        <div className="p-6 space-y-4 max-h-[65vh] overflow-y-auto">
          <Field label="Role titles" hint="One per line, as job posts name them: “SDR”, “Head of RevOps”.">
            <textarea className="input w-full h-24" value={roles} onChange={e => setRoles(e.target.value)} autoFocus
              aria-label="Role titles" placeholder={'Sales Development Representative\nRevOps Manager'} />
          </Field>
          <div className="grid grid-cols-[6rem_1fr] gap-3">
            <Field label="Country" hint="Empty: any.">
              <input className="input w-full" value={country} maxLength={2} onChange={e => setCountry(e.target.value)}
                aria-label="Country" />
            </Field>
            <Field label="City or region (optional)">
              <input className="input w-full" value={place} onChange={e => setPlace(e.target.value)}
                aria-label="City or region" placeholder="Texas" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Posted within">
              <select className="input w-full" value={days ?? ''} aria-label="Posted within"
                onChange={e => setDays(e.target.value ? Number(e.target.value) : null)}>
                {HIRING_POSTED_CHOICES.map(d => <option key={d} value={d}>{d} days</option>)}
                <option value="">Any time</option>
              </select>
            </Field>
            <Field label="Roles per search" hint={`At most ${HIRING_MAX_PER_SEARCH}: the cost goes with it.`}>
              <input className="input w-full" type="number" min={1} max={HIRING_MAX_PER_SEARCH} value={perSearch}
                onChange={e => setPerSearch(e.target.value)} aria-label="Roles per search" />
            </Field>
          </div>
          <HiringMoreOptions value={options} onChange={setOptions} />
          <p className="text-xs text-gray-500">
            Nothing is searched yet. The table opens on what its first check costs (treg bills each role found), and
            checks when you say so. Each check adds only roles never found before.
          </p>
        </div>
        <div className="p-6 pt-0 flex items-center gap-3">
          <span className="text-xs text-gray-500 flex-1">
            {problem ?? `${titles.length} search${titles.length === 1 ? '' : 'es'}, up to ${per} roles each`}
          </span>
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={!!problem || busy} className="btn-primary disabled:opacity-50"
            data-testid="hiring-create">
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

// The way in: a button that opens the dialog (the dashboard, the New Table dialog, the enrichment drawer).
export const HiringButton: React.FC<{ className?: string }> = ({ className = '' }) => {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} data-testid="hiring-open"
        className={`btn-secondary flex items-center justify-center gap-2 text-sm px-4 py-2 ${className}`}>
        <Briefcase className="h-4 w-4" /><span>Find companies hiring</span>
      </button>
      {open && <HiringDialog isOpen={open} onClose={() => setOpen(false)} />}
    </>
  )
}
