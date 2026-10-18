import React, { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import toast from 'react-hot-toast'

// A run webhook's signing secret, shown once (when it's made). Cubex keeps it
// encrypted and never shows it again; a lost one is replaced with New secret.
export const RunWebhookSecret: React.FC<{ secret: string }> = ({ secret }) => {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      toast.success('Secret copied to clipboard')
    } catch {
      toast.error('Copy failed. Select the secret text and copy it yourself')
    }
  }
  return (
    <div className="space-y-3">
      <div className="flex items-stretch space-x-2">
        <code data-testid="run-webhook-secret"
          className="flex-1 bg-gray-50 border border-gray-200 rounded px-3 py-2 text-xs break-all select-all">
          {secret}
        </code>
        <button onClick={copy} className="btn-secondary px-3 flex items-center" title="Copy secret">
          {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-3">
        This is the only time the secret is shown. Put it where your receiver can read it, and use it to check the
        X-Cubex-Signature header of each POST: HMAC-SHA256 of the request body with this secret.
      </p>
    </div>
  )
}
