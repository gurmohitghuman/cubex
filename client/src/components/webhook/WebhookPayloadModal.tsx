import React, { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Modal } from '@/components/Modal'
import { X, Loader2 } from 'lucide-react'
import { webhooksAPI, type WebhookDelivery } from '@/utils/api/webhooks'

// What "Add again" did, in the toast.
const addedText = (out: { status: string; replaced: number }): string => out.status === 'duplicate'
  ? 'Added again, but auto-dedupe didn\'t keep it: another row has the same key.'
  : out.replaced > 0
    ? 'Added again as a new row. Auto-dedupe keeps the newest, so the earlier row with its key went to the trash.'
    : out.status === 'partial'
      ? 'Added again as a new row. Some mappings found nothing in it.'
      : 'Added again as a new row, with the mappings as they are now.'

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
  const [adding, setAdding] = useState(false)

  // A delivery read again with the webhook's current mappings (after fixing one,
  // say): a new row, like a new arrival, auto-dedupe included.
  const addAgain = async () => {
    if (!sheetId || !delivery) return
    setAdding(true)
    try {
      const out = await webhooksAPI.replayDelivery(sheetId, delivery.id)
      toast.success(addedText(out), { duration: 6000 })
      onClose()
    } catch (e: any) {
      toast.error(e?.response?.data?.error || "Couldn't add it again.")
    } finally {
      setAdding(false)
    }
  }

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
      {delivery && delivery.retained && delivery.payload != null && (
        <div className="flex items-center justify-between gap-3 border-t border-gray-200 px-4 py-3">
          <p className="text-xs text-gray-500">Fixed a mapping? Add this delivery again as a new row.</p>
          <button type="button" onClick={addAgain} disabled={adding} className="btn-secondary shrink-0 text-sm">
            {adding ? 'Adding…' : 'Add again'}
          </button>
        </div>
      )}
    </Modal>
  )
}
