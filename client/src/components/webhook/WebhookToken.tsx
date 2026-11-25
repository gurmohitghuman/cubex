import React, { useState } from 'react'
import { Copy, Check, KeyRound } from 'lucide-react'
import toast from 'react-hot-toast'
import { webhooksAPI, type WebhookSource } from '@/utils/api/webhooks'
import { ConfirmDialog } from '../ConfirmDialog'

// The webhook's optional token (services/sheet-webhook.ts): with one, an event must send it as
// Authorization: Bearer <token> or it is turned away, so a leaked URL alone can't add rows. The token is shown
// once, right after it is made, and only here; it isn't kept anywhere the page can read it again.
// Each change asks first: requiring a token turns away senders that don't send it yet (they get "not found" and
// many don't try again), a new one stops the old, and removing it opens the URL to anyone who has it.
const CONFIRM = {
  require: { title: 'Require a token?', button: 'Require a token',
    message: 'Events that don\'t send the token are turned away from now on, so add it to each sender right after.' },
  new: { title: 'Make a new token?', button: 'Make new token',
    message: 'The current token stops working right away, so every sender has to be given the new one.' },
  remove: { title: 'Remove the token?', button: 'Remove token', message: 'Anyone with the URL can add rows again.' },
}

export function WebhookToken({ sheetId, source, onSource }: {
  sheetId: string
  source: WebhookSource
  onSource: (source: WebhookSource) => void
}) {
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirm, setConfirm] = useState<'require' | 'new' | 'remove' | null>(null)

  const make = async () => {
    setBusy(true)
    try {
      const out = await webhooksAPI.newToken(sheetId)
      onSource(out.source)
      setToken(out.token)
      setCopied(false)
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not make a token.')
    } finally { setBusy(false) }
  }
  const remove = async () => {
    setBusy(true)
    try {
      onSource((await webhooksAPI.removeToken(sheetId)).source)
      setToken(null)
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not remove the token.')
    } finally { setBusy(false) }
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token!)
      setCopied(true)
    } catch {
      toast.error('Copy failed. Select and copy it yourself.')
    }
  }

  return (
    <section className="space-y-2" data-testid="webhook-token">
      <h3 className="text-sm font-semibold text-gray-900">Token</h3>
      {token ? (
        <div className="space-y-1">
          <p className="text-xs text-gray-600">
            Send this with every event as the header <code>Authorization: Bearer &lt;token&gt;</code>.
          </p>
          <div className="flex items-center gap-2">
            <code className={'flex-1 min-w-0 truncate rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs'
              + ' font-mono text-gray-800'}
              data-testid="webhook-token-value">
              {token}
            </code>
            <button type="button" onClick={copy} className="btn-secondary flex items-center gap-1 flex-shrink-0">
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <p className="text-xs text-amber-600">Copy it now. It isn&apos;t shown again.</p>
        </div>
      ) : (
        <p className="text-xs text-gray-600">
          {source.tokenRequired
            ? 'Events must send the token. Events without it are turned away.'
            : 'Optional. With a token, only senders that send it can add rows, even if the URL gets out.'}
        </p>
      )}

      <div className="flex gap-2">
        {source.tokenRequired ? (
          <>
            <button type="button" onClick={() => setConfirm('new')} disabled={busy}
              className="btn-secondary flex items-center gap-1 disabled:opacity-50">
              <KeyRound className="h-3 w-3" /><span>New token</span>
            </button>
            <button type="button" onClick={() => setConfirm('remove')} disabled={busy}
              className="btn-secondary disabled:opacity-50">
              Remove token
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirm('require')} disabled={busy}
            className="btn-secondary flex items-center gap-1 disabled:opacity-50">
            <KeyRound className="h-3 w-3" /><span>{busy ? 'Making…' : 'Require a token'}</span>
          </button>
        )}
      </div>

      <ConfirmDialog
        isOpen={confirm !== null}
        title={CONFIRM[confirm ?? 'new'].title}
        message={CONFIRM[confirm ?? 'new'].message}
        confirmText={CONFIRM[confirm ?? 'new'].button} isDestructive zClassName="z-[20010]"
        onConfirm={() => { const what = confirm; setConfirm(null); void (what === 'remove' ? remove() : make()) }}
        onCancel={() => setConfirm(null)}
      />
    </section>
  )
}
