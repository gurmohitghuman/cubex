import React, { useState } from 'react'
import { Copy, Check, RotateCw, Lock } from 'lucide-react'
import toast from 'react-hot-toast'
import type { WebhookSource } from '@/utils/api/webhooks'
import { ConfirmDialog } from '../ConfirmDialog'

// Endpoint section of the drawer: the URL (revealable until the first event,
// then masked), a copy button, a copyable curl, and Rotate. After the first
// delivery the URL is masked permanently — the user must Rotate to get a new one.
export function WebhookEndpoint({
  source, onRotate, rotating,
}: {
  source: WebhookSource
  onRotate: () => void
  rotating: boolean
}) {
  const [copied, setCopied] = useState<'url' | 'curl' | null>(null)
  const [confirmRotate, setConfirmRotate] = useState(false)

  const copy = async (what: 'url' | 'curl', text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      toast.error('Copy failed. Select and copy manually.')
    }
  }

  // The server sends a full URL when PUBLIC_URL is set, otherwise just the path;
  // resolving against this page's origin turns the path into the address the
  // user is actually reaching Cubex on.
  const url = source.url ? new URL(source.url, window.location.origin).href : null
  const curl = url
    ? `curl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"example":"value"}'`
    : ''

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">Endpoint</h3>

      {source.masked ? (
        <div className="flex items-start gap-2 rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
          <Lock className="h-4 w-4 mt-0.5 flex-shrink-0 text-gray-400" />
          <div>
            <p className="font-medium text-gray-700">URL hidden</p>
            <p className="text-xs mt-0.5">
              The webhook URL is masked after the first event for security. If you lost it,
              rotate to generate a new one (the old URL stops working immediately).
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="space-y-1">
            <label className="text-xs text-gray-500">POST JSON to this URL</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs font-mono text-gray-800">
                {url}
              </code>
              <button
                type="button"
                onClick={() => copy('url', url!)}
                className="btn-secondary flex items-center gap-1 flex-shrink-0"
              >
                {copied === 'url' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                <span>{copied === 'url' ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-xs text-gray-500">Or test with curl</label>
              <button
                type="button"
                onClick={() => copy('curl', curl)}
                className="text-xs text-gray-500 hover:text-cube-black inline-flex items-center gap-1"
              >
                {copied === 'curl' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied === 'curl' ? 'Copied' : 'Copy curl'}
              </button>
            </div>
            <pre className="overflow-x-auto rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-[11px] font-mono text-gray-700 whitespace-pre">{curl}</pre>
          </div>

          <p className="text-xs text-amber-600">
            ⚠ Copy this URL now. It's hidden after your first event arrives.
          </p>
        </>
      )}

      <ConfirmDialog
        isOpen={confirmRotate}
        title="Rotate the webhook URL?"
        message="The current URL stops working right away, so anything sending to it has to be updated with the new one."
        confirmText="Rotate URL" isDestructive zClassName="z-[20010]"
        onConfirm={() => { setConfirmRotate(false); onRotate() }}
        onCancel={() => setConfirmRotate(false)}
      />
      <button
        type="button"
        onClick={() => setConfirmRotate(true)}
        disabled={rotating}
        className="btn-secondary flex items-center gap-1 disabled:opacity-50"
      >
        <RotateCw className={`h-3 w-3 ${rotating ? 'animate-spin' : ''}`} />
        <span>Rotate URL</span>
      </button>
    </section>
  )
}
