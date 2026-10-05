import React, { useEffect, useState } from 'react'
import { Modal } from '@/components/Modal'
import { X, Loader2 } from 'lucide-react'
import { webhooksAPI, type WebhookDelivery } from '@/utils/api/webhooks'

// Row-level "View webhook payload" panel. Fetches the raw payload on demand for a
// specific row (the delivery that created it). Opened by clicking a webhook-source
// marker cell. Ownership-checked server-side.
export function WebhookPayloadModal({
  isOpen, onClose, sheetId, rowIndex,
}: {
  isOpen: boolean
  onClose: () => void
  sheetId: string | null
  rowIndex: number | null
}) {
  const [loading, setLoading] = useState(false)
  const [delivery, setDelivery] = useState<WebhookDelivery | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen || !sheetId || rowIndex == null) return
    let cancelled = false
    setLoading(true); setError(null); setDelivery(null)
    webhooksAPI.rawForRowIndex(sheetId, rowIndex)
      .then(d => { if (!cancelled) setDelivery(d) })
      .catch((e: any) => { if (!cancelled) setError(e?.response?.data?.error || 'No payload for this row.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [isOpen, sheetId, rowIndex])

  return (
    <Modal isOpen={isOpen} onClose={onClose} panelClassName="max-w-lg">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 h-12">
        <h2 className="text-sm font-semibold text-gray-900">Webhook payload</h2>
        <button type="button" onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="p-4 max-h-[60vh] overflow-y-auto">
        {loading ? (
          <div className="flex justify-center py-8 text-gray-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : error ? (
          <p className="text-sm text-gray-500">{error}</p>
        ) : delivery && delivery.retained && delivery.payload != null ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-gray-700">
            {JSON.stringify(delivery.payload, null, 2)}
          </pre>
        ) : (
          <p className="text-sm text-gray-500">Raw payload no longer retained for this row.</p>
        )}
      </div>
    </Modal>
  )
}
