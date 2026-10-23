import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Loader2, Radar } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { aiVisibilityAPI } from '@/utils/api/ai-visibility'
import { AI_ENGINES, AI_VISIBILITY_MAX_QUESTIONS, linesOf, type AiEngineId } from '@/lib/ai-visibility'

// "Check AI visibility": a new table that asks AI engines the questions your
// buyers ask and says whether each answer names you. Making it asks nothing
// and costs nothing: the table's guide asks the engines, after an estimate.
interface Props { isOpen: boolean; onClose: () => void }

export const AiVisibilityDialog: React.FC<Props> = ({ isOpen, onClose }) => {
  const navigate = useNavigate()
  const [brand, setBrand] = useState('')
  const [others, setOthers] = useState('')
  const [domain, setDomain] = useState('')
  const [country, setCountry] = useState('US')
  const [engines, setEngines] = useState<AiEngineId[]>(AI_ENGINES.filter(e => e.defaultOn).map(e => e.id))
  const [questions, setQuestions] = useState('')
  const [busy, setBusy] = useState(false)
  const asked = linesOf(questions)
  const problem = !brand.trim() ? 'Add your brand.'
    : asked.length === 0 ? 'Add at least one question.'
    : asked.length > AI_VISIBILITY_MAX_QUESTIONS ? `Start with at most ${AI_VISIBILITY_MAX_QUESTIONS} questions.`
    : engines.length === 0 ? 'Pick at least one engine.'
    : !/^[A-Za-z]{2}$/.test(country.trim()) ? 'The country is two letters, such as US or GB.' : null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (problem || busy) return
    setBusy(true)
    try {
      const made = await aiVisibilityAPI.create({
        brand: brand.trim(), competitors: linesOf(others, true), domain: domain.trim(),
        country: country.trim().toUpperCase(), engines, questions: asked,
      })
      onClose()
      navigate(`/table/${made.id}/${made.sheetId}`)
      if (made.problems.length) toast.error(`The table is ready, but something didn't finish: ${made.problems[0]}`)
    } catch (err: any) {
      toast.error(err?.response?.data?.error || "Couldn't make the table.")
      setBusy(false)
    }
  }

  const toggle = (id: AiEngineId) =>
    setEngines(on => (on.includes(id) ? on.filter(x => x !== id) : AI_ENGINES.map(x => x.id)
      .filter(x => x === id || on.includes(x))))

  return (
    <Modal isOpen={isOpen} onClose={onClose} panelClassName="max-w-lg w-full">
      <form onSubmit={submit} data-testid="ai-visibility-dialog">
        <div className="p-6 border-b border-gray-200 flex items-center gap-3">
          <div className="w-10 h-10 bg-cube-black flex items-center justify-center">
            <Radar className="h-5 w-5 text-white" />
          </div>
          <div>
            <h3 className="text-title text-gray-900">Check AI visibility</h3>
            <p className="text-xs text-gray-500">Do AI engines name you when buyers ask? A table that asks them.</p>
          </div>
        </div>
        <div className="p-6 space-y-4 max-h-[65vh] overflow-y-auto">
          <Field label="Your brand" hint="As an answer would name it.">
            <input className="input w-full" value={brand} onChange={e => setBrand(e.target.value)} autoFocus
              aria-label="Your brand" placeholder="Acme CRM" />
          </Field>
          <Field label="Other brands to look for" hint="Your competitors, one per line or comma.">
            <textarea className="input w-full h-16" value={others} onChange={e => setOthers(e.target.value)}
              aria-label="Other brands to look for" />
          </Field>
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <Field label="Your site (optional)" hint="Marks the cited sources on it.">
              <input className="input w-full" value={domain} onChange={e => setDomain(e.target.value)}
                aria-label="Your site" placeholder="acme.com" />
            </Field>
            <Field label="Country" hint="Asked from.">
              <input className="input w-full" value={country} maxLength={2} onChange={e => setCountry(e.target.value)}
                aria-label="Country" />
            </Field>
          </div>
          <Field label="Engines">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {AI_ENGINES.map(e => (
                <label key={e.id} className="flex items-center gap-1.5 text-sm text-gray-700">
                  <input type="checkbox" checked={engines.includes(e.id)} onChange={() => toggle(e.id)} />{e.name}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Questions"
            hint="One per line, as a buyer would ask: “What's the best CRM for a small team?”">
            <textarea className="input w-full h-28" value={questions} onChange={e => setQuestions(e.target.value)}
              aria-label="Questions" />
          </Field>
          <p className="text-xs text-gray-500">
            Nothing is asked yet. The table's guide shows what asking costs (treg bills each answer, a fraction of a
            cent), and asks when you say so.
          </p>
        </div>
        <div className="p-6 pt-0 flex items-center gap-3">
          <span className="text-xs text-gray-500 flex-1">
            {problem ?? `${asked.length} questions, ${engines.length} engines`}
          </span>
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={!!problem || busy} className="btn-primary disabled:opacity-50"
            data-testid="ai-visibility-create">
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
export const AiVisibilityButton: React.FC<{ className?: string }> = ({ className = '' }) => {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} data-testid="ai-visibility-open"
        className={`btn-secondary flex items-center justify-center gap-2 text-sm px-4 py-2 ${className}`}>
        <Radar className="h-4 w-4" /><span>Check AI visibility</span>
      </button>
      {open && <AiVisibilityDialog isOpen={open} onClose={() => setOpen(false)} />}
    </>
  )
}
