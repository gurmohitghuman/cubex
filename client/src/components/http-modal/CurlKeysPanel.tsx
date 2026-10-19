import React from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import type { CurlKeyFinding } from '@/utils/api'
import type { KeyDraft, useCurlImport } from './useCurlImport'
import { Select } from '@/components/ui/Select'

type CurlImport = ReturnType<typeof useCurlImport>

// "Keys in this command": what to do with each key the pasted command holds or
// needs. Keys live as saved keys, never in the column, so the choices are save
// it, use one already saved, or leave it out. The key itself is never shown,
// only a masked hint.
export const CurlKeysPanel: React.FC<{ c: CurlImport }> = ({ c }) => (
  <div className="space-y-3" data-testid="curl-keys-panel">
    <div>
      <p className="flex items-center gap-2 text-sm font-medium text-gray-700">
        <KeyRound className="h-4 w-4" />Keys in this command
      </p>
      <p className="text-xs text-gray-500 mt-1">
        Cubex keeps keys as saved keys (Settings, External service keys), never inside a column.
        Choose what to do with each one.
      </p>
    </div>
    {(c.keys ?? []).map(k => (
      <KeyRow key={k.id} k={k} d={c.drafts[k.id]} savedKeyNames={c.savedKeyNames}
        set={patch => c.setDraft(k.id, patch)} />
    ))}
    <div className="flex justify-end gap-2">
      <button type="button" onClick={c.backToCommand} className="btn-secondary">Back</button>
      <button type="button" onClick={c.confirmKeys} disabled={c.busy} data-testid="curl-keys-confirm"
        className="btn-primary flex items-center gap-2">
        {c.busy && <Loader2 className="h-4 w-4 animate-spin" />}Save and fill in
      </button>
    </div>
  </div>
)

function KeyRow({ k, d, savedKeyNames, set }: {
  k: CurlKeyFinding
  d: KeyDraft | undefined
  savedKeyNames: string[]
  set: (patch: Partial<KeyDraft>) => void
}) {
  if (!d) return null
  const choices = [...new Set([...savedKeyNames, ...(k.existingKey ? [k.existingKey] : [])])]
  // The fields sit outside the radio's label, so the radio is named by its text alone.
  const option = (action: KeyDraft['action'], label: string, body?: React.ReactNode) => (
    <div>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="radio" name={`curl-key-${k.id}`} checked={d.action === action} onChange={() => set({ action })} />
        {label}
      </label>
      {d.action === action && body && <div className="pl-6 mt-1 space-y-1">{body}</div>}
    </div>
  )
  return (
    <div className="border border-gray-200 rounded p-2 space-y-2" data-testid={`curl-key-${k.id}`}>
      <p className="text-sm">
        <span className="font-medium text-gray-800">{k.where}</span>{' '}
        {k.hint && <span className="font-mono text-xs text-gray-500">{k.hint}</span>}
        {k.kind === 'missing' && (
          <span className="text-xs text-gray-500">needs a key{k.placeholder ? ` (${k.placeholder})` : ''}</span>
        )}
      </p>
      {k.existingKey && <p className="text-xs text-gray-500">Already saved as {k.existingKey}.</p>}
      {option('save', 'Save it as a new key named', (
        <>
          <input className="input w-full" value={d.name} aria-label="New key name"
            onChange={e => set({ name: e.target.value })} />
          {k.kind === 'missing' && !k.basic && (
            <input type="password" className="input w-full" placeholder="Paste the key" value={d.value}
              aria-label="The key" autoComplete="off" onChange={e => set({ value: e.target.value })} />
          )}
          {k.kind === 'missing' && k.basic && (
            <div className="flex gap-2">
              <input className="input flex-1" placeholder="User" value={d.user} aria-label="User" autoComplete="off"
                onChange={e => set({ user: e.target.value })} />
              <input type="password" className="input flex-1" placeholder="Password" value={d.password}
                aria-label="Password" autoComplete="off" onChange={e => set({ password: e.target.value })} />
            </div>
          )}
        </>
      ))}
      {choices.length > 0 && option('use', 'Use a saved key', (
        <Select className="w-full" value={d.useName} label="Saved key" onChange={v => set({ useName: v })}
          options={[{ value: '', label: 'Pick a saved key' }, ...choices.map(n => ({ value: n, label: n }))]} />
      ))}
      {k.canDrop && option('drop', k.cookie ? "Leave it out (a browser's sign-in cookie rarely works for an API)"
        : 'Leave it out')}
    </div>
  )
}
