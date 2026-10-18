import React, { useEffect, useState } from 'react'
import { Loader2, Webhook } from 'lucide-react'
import toast from 'react-hot-toast'
import { runWebhooksAPI } from '@/utils/api'
import { RunWebhookSecret } from './RunWebhookSecret'

interface Props {
  isOpen: boolean
  onClose: () => void
  onCreated: () => Promise<void>
}

// Two steps: the URL and who it hears about, then the secret, shown once.
export const RunWebhookCreateModal: React.FC<Props> = ({ isOpen, onClose, onCreated }) => {
  const [url, setUrl] = useState('')
  const [everyRun, setEveryRun] = useState(true)
  const [busy, setBusy] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen) { setUrl(''); setEveryRun(true); setSecret(null) }
  }, [isOpen])

  if (!isOpen) return null

  const create = async () => {
    if (!url.trim() || busy) return
    setBusy(true)
    try {
      const made = await runWebhooksAPI.create(url.trim(), everyRun)
      setSecret(made.secret)
      await onCreated()
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to add the webhook')
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 bg-cube-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4" role="dialog" aria-label="Add a run webhook">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center space-x-3">
            <div className="bg-gray-100 p-2 rounded-lg"><Webhook className="h-5 w-5 text-gray-700" /></div>
            <div>
              <h3 className="text-title text-gray-900">{secret ? 'Webhook added' : 'Add a run webhook'}</h3>
              <p className="text-sm text-gray-600">
                {secret ? 'Copy the secret now. You won’t see it again' : 'Cubex POSTs here when a run finishes'}
              </p>
            </div>
          </div>
        </div>

        {secret ? (
          <div className="p-6"><RunWebhookSecret secret={secret} /></div>
        ) : (
          <div className="p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">URL *</label>
              <input type="url" className="input w-full" placeholder="https://example.com/cubex-runs" value={url}
                data-testid="run-webhook-url" onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); create() }
                }} />
              <p className="text-xs text-gray-500 mt-1">A public http(s) address. Redirects aren&apos;t followed.</p>
            </div>
            <label className="flex items-start space-x-2">
              <input type="checkbox" className="mt-0.5" checked={everyRun} data-testid="run-webhook-every-run"
                onChange={(e) => setEveryRun(e.target.checked)} />
              <span className="text-sm">
                <span className="font-medium text-gray-900">Tell it about every run</span>
                <span className="block text-xs text-gray-500">
                  Every AI, HTTP, enrichment and setup run, auto-runs included. Off: only runs started over the API
                  or MCP with this webhook&apos;s id.
                </span>
              </span>
            </label>
          </div>
        )}

        <div className="flex space-x-3 p-6 border-t border-gray-200">
          {secret ? (
            <button onClick={onClose} className="btn-primary flex-1">Done</button>
          ) : (
            <>
              <button onClick={onClose} className="btn-secondary flex-1">Cancel</button>
              <button onClick={create} disabled={busy || !url.trim()} data-testid="run-webhook-create"
                className="btn-primary flex-1 disabled:opacity-50">
                {busy ? (
                  <span className="flex items-center justify-center space-x-2">
                    <Loader2 className="h-4 w-4 animate-spin text-white" /><span>Adding…</span>
                  </span>
                ) : 'Add webhook'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
