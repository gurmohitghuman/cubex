import React, { useState } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import type { WebhookDelivery } from '@/utils/api/webhooks'

// Deliveries section: recent events (newest first), each expandable to show its
// raw payload. A 'pruned' delivery kept its row but dropped the raw JSON.
export function WebhookDeliveries({ deliveries }: { deliveries: WebhookDelivery[] }) {
  const [openId, setOpenId] = useState<string | null>(null)

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-gray-900">Recent deliveries</h3>
      {deliveries.length === 0 ? (
        <p className="text-sm text-gray-500">No events received yet.</p>
      ) : (
        <div className="space-y-1">
          {deliveries.map(d => {
            const open = openId === d.id
            return (
              <div key={d.id} className="rounded border border-gray-100 text-xs">
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : d.id)}
                  className="flex w-full items-center justify-between px-2 py-1.5 hover:bg-gray-50"
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    <span className="text-gray-700">{new Date(d.receivedAt + 'Z').toLocaleString()}</span>
                    <StatusBadge status={d.status} />
                  </span>
                  <span className="text-gray-400 flex-shrink-0">{formatBytes(d.payloadBytes)}</span>
                </button>
                {open && (
                  <div className="border-t border-gray-100 px-2 py-1.5">
                    {d.errorMessage && (
                      <p className="text-red-600 mb-1">⚠ {d.errorMessage}</p>
                    )}
                    {d.retained && d.payload != null ? (
                      <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-gray-700 max-h-48 overflow-y-auto">
                        {JSON.stringify(d.payload, null, 2)}
                      </pre>
                    ) : (
                      <p className="text-gray-400 italic">Raw payload no longer retained.</p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function StatusBadge({ status }: { status: WebhookDelivery['status'] }) {
  const map: Record<WebhookDelivery['status'], { label: string; cls: string }> = {
    stored: { label: 'stored', cls: 'bg-green-100 text-green-700' },
    partial: { label: 'partial', cls: 'bg-amber-100 text-amber-700' },
    pruned: { label: 'pruned', cls: 'bg-gray-100 text-gray-500' },
    error: { label: 'error', cls: 'bg-red-100 text-red-700' },
  }
  const s = map[status] ?? map.stored
  return <span className={`px-1.5 py-0.5 rounded text-[10px] ${s.cls}`}>{s.label}</span>
}

function formatBytes(n: number): string {
  if (n <= 0) return '-'
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}
