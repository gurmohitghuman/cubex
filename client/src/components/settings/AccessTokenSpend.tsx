import React, { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { AccessToken, settingsAPI } from '@/utils/api'
import { spent as fmtSpent, usd } from '@/lib/enrich-format'

// A token's lifetime spend cap (AI + enrichments), in its Settings row: what
// it spent, the cap and what is left, and an editor. Raising the cap lets its
// runs paused at the cap be resumed; its auto-runs go on by themselves.
export const LIFETIME_HINT =
  "The cap is for the token's whole life, not a month: raise it to go on, or make a new token."

// '' is no cap; anything else must be a dollar amount (the server checks the range).
export const parseCapInput = (raw: string): number | null | 'bad' => {
  const t = raw.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : 'bad'
}

export const CAP_HELP = 'Type a dollar amount, or leave it empty for no cap'
// A number field holding something it can't read as a number ("1..2", "-") gives '' as its value, which would
// read as no cap: such a field is refused instead (validity.badInput), never saved as no cap.
export const capUnreadable = (input: HTMLInputElement | null): boolean => input?.validity.badInput === true

// The create dialog's field: empty is no cap. inputRef: the dialog checks it can read the field before creating.
export const SpendCapField: React.FC<{
  value: string; onChange: (v: string) => void; inputRef: React.RefObject<HTMLInputElement>
}> = ({ value, onChange, inputRef }) => {
  const [unreadable, setUnreadable] = useState(false)
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2" htmlFor="token-spend-cap">Spend cap ($)</label>
      <input
        id="token-spend-cap" type="number" min="0" step="0.01" className="input w-full" placeholder="No cap"
        ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)}
        onInput={(e) => setUnreadable(capUnreadable(e.currentTarget))}
      />
      {(unreadable || parseCapInput(value) === 'bad') && (
        <p className="text-xs text-red-600 mt-1" role="alert">{CAP_HELP}.</p>
      )}
      <p className="text-xs text-gray-500 mt-1">
        The most its AI runs, enrichments, previews and AI helpers may spend. At the cap, new runs are refused and
        running ones pause. {LIFETIME_HINT}
      </p>
    </div>
  )
}

interface Props { token: AccessToken; onSaved: () => Promise<void> }

export const AccessTokenSpend: React.FC<Props> = ({ token, onSaved }) => {
  const s = token.spend
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const atCap = s.spend_cap_usd !== null && (s.left_usd ?? 0) <= 0

  const open = () => { setValue(s.spend_cap_usd === null ? '' : String(s.spend_cap_usd)); setEditing(true) }
  const save = async () => {
    const cap = parseCapInput(value)
    if (cap === 'bad' || capUnreadable(input.current)) { toast.error(CAP_HELP); return }
    setBusy(true)
    try {
      await settingsAPI.setAccessTokenSpendCap(token.id, cap)
      await onSaved()
      setEditing(false)
      toast.success(cap === null ? `"${token.name}" has no spend cap now`
        : `"${token.name}" may spend ${usd(cap)} in all`)
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to save the spend cap')
    } finally { setBusy(false) }
  }

  if (editing) {
    return (
      <div className="mt-2 space-y-1" data-testid="token-cap-editor">
        <div className="flex items-center space-x-2">
          <span className="text-xs text-gray-600">Spend cap $</span>
          <input
            type="number" min="0" step="0.01" autoFocus ref={input}
            className="input text-sm w-28 py-1" placeholder="No cap" aria-label={`Spend cap for ${token.name}`}
            value={value} onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false)
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && !busy) { e.preventDefault(); save() }
            }}
          />
          <button onClick={save} disabled={busy} className="btn-primary text-xs px-3 py-1 disabled:opacity-50">
            {busy ? <Loader2 className="h-3 w-3 animate-spin text-white" /> : 'Save'}
          </button>
          <button onClick={() => setEditing(false)} disabled={busy} className="btn-secondary text-xs px-3 py-1">
            Cancel
          </button>
        </div>
        <p className="text-xs text-gray-500">AI and enrichments this token runs. {LIFETIME_HINT}</p>
      </div>
    )
  }
  return (
    <p className={`text-xs mt-1 ${atCap ? 'text-amber-700' : 'text-gray-500'}`} data-testid="token-spend">
      {fmtSpent(s.spent_usd)} spent
      {s.spend_cap_usd === null ? ' · No spend cap'
        : ` of its ${usd(s.spend_cap_usd)} cap · ${fmtSpent(s.left_usd ?? 0)} left`}
      {atCap ? ' · At the cap: new runs are refused and running ones pause' : ''}
      <button onClick={open} className="ml-2 underline hover:text-gray-700" title={LIFETIME_HINT}>
        {s.spend_cap_usd === null ? 'Set a cap' : 'Change cap'}
      </button>
    </p>
  )
}
