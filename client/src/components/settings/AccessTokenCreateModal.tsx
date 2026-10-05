import React, { useEffect, useState } from 'react'
import { Check, Copy, KeyRound, Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { AccessTokenScope, CreatedAccessToken, settingsAPI } from '@/utils/api'

interface Props {
  isOpen: boolean
  onClose: () => void
  onCreated: () => Promise<void>
}

const SCOPE_OPTIONS: Array<{ scope: AccessTokenScope; label: string; hint: string }> = [
  { scope: 'read', label: 'Read', hint: 'Read tables, sheets, and rows' },
  { scope: 'write', label: 'Write', hint: 'Create and edit tables, columns, and rows' },
  { scope: 'run', label: 'Run', hint: 'Start and control AI and HTTP enrichment runs' },
  { scope: 'secrets', label: 'Use saved API keys', hint: 'Let runs started with this token reference your saved API keys (/key_name)' },
]

const EXPIRY_OPTIONS = [
  { label: 'Never expires', days: null },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
]

// Two-phase modal: the form, then a SHOW-ONCE view of the created token —
// the server stores only its hash, so this is the single chance to copy it.
export const AccessTokenCreateModal: React.FC<Props> = ({ isOpen, onClose, onCreated }) => {
  const [name, setName] = useState('')
  // Design default: read+write+run on, secrets off (the key-exfiltration gate).
  const [scopes, setScopes] = useState<Set<AccessTokenScope>>(new Set(['read', 'write', 'run']))
  const [expiryDays, setExpiryDays] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<CreatedAccessToken | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (isOpen) {
      setName(''); setScopes(new Set(['read', 'write', 'run'])); setExpiryDays(null)
      setCreated(null); setCopied(false)
    }
  }, [isOpen])

  if (!isOpen) return null

  const toggleScope = (scope: AccessTokenScope) => {
    const next = new Set(scopes)
    if (next.has(scope)) {
      next.delete(scope)
      if (scope === 'run') next.delete('secrets') // secrets requires run
    } else {
      next.add(scope)
    }
    setScopes(next)
  }

  const canSubmit = !!name.trim() && scopes.size > 0
  const handleCreate = async () => {
    if (!canSubmit) return
    setBusy(true)
    try {
      const token = await settingsAPI.createAccessToken({
        name: name.trim(),
        scopes: [...scopes],
        expires_in_days: expiryDays,
      })
      setCreated(token)
      await onCreated()
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to create access token')
    } finally { setBusy(false) }
  }

  const handleCopy = async () => {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.token)
      setCopied(true)
      toast.success('Token copied to clipboard')
    } catch {
      toast.error('Copy failed. Select the token text and copy manually')
    }
  }

  return (
    <div className="fixed inset-0 bg-cube-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center space-x-3">
            <div className="bg-gray-100 p-2 rounded-lg"><KeyRound className="h-5 w-5 text-gray-700" /></div>
            <div>
              <h3 className="text-title text-gray-900">{created ? 'Access token created' : 'Create access token'}</h3>
              <p className="text-sm text-gray-600">
                {created ? 'Copy it now. You won’t see it again' : 'For AI agents (MCP) and scripts'}
              </p>
            </div>
          </div>
        </div>

        {created ? (
          <div className="p-6 space-y-4">
            <div className="flex items-stretch space-x-2">
              <code className="flex-1 bg-gray-50 border border-gray-200 rounded px-3 py-2 text-xs break-all select-all">
                {created.token}
              </code>
              <button onClick={handleCopy} className="btn-secondary px-3 flex items-center" title="Copy token">
                {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-3">
              This is the only time the full token is shown. Cubex stores only a hash of it.
              Treat it like a password. Anyone holding it can act on your account within its scopes.
            </p>
          </div>
        ) : (
          <div className="p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Name *</label>
              <input
                type="text"
                className="input w-full"
                placeholder="e.g., Claude MCP, enrichment-script"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229 && !busy && canSubmit) { e.preventDefault(); handleCreate() } }}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Scopes *</label>
              <div className="space-y-2">
                {SCOPE_OPTIONS.map(({ scope, label, hint }) => {
                  const secretsLocked = scope === 'secrets' && !scopes.has('run')
                  return (
                    <label key={scope} className={`flex items-start space-x-2 ${secretsLocked ? 'opacity-50' : ''}`}>
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={scopes.has(scope)}
                        disabled={secretsLocked}
                        onChange={() => toggleScope(scope)}
                      />
                      <span className="text-sm">
                        <span className="font-medium text-gray-900">{label}</span>
                        <span className="block text-xs text-gray-500">{hint}</span>
                      </span>
                    </label>
                  )
                })}
              </div>
              {scopes.has('secrets') && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mt-2">
                  A leaked token with this scope could send your saved API keys to a third party.
                  Grant it only to tools you fully trust.
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Expiration</label>
              <select
                className="input w-full"
                value={expiryDays === null ? 'never' : String(expiryDays)}
                onChange={(e) => setExpiryDays(e.target.value === 'never' ? null : Number(e.target.value))}
              >
                {EXPIRY_OPTIONS.map(({ label, days }) => (
                  <option key={label} value={days === null ? 'never' : String(days)}>{label}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="flex space-x-3 p-6 border-t border-gray-200">
          {created ? (
            <button onClick={onClose} className="btn-primary flex-1">Done</button>
          ) : (
            <>
              <button onClick={onClose} className="btn-secondary flex-1">Cancel</button>
              <button onClick={handleCreate} disabled={busy || !canSubmit} className="btn-primary flex-1 disabled:opacity-50">
                {busy ? (
                  <div className="flex items-center justify-center space-x-2">
                    <Loader2 className="h-4 w-4 animate-spin text-white" /><span>Creating…</span>
                  </div>
                ) : 'Create token'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
