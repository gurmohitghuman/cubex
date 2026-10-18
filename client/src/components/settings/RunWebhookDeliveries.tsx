import React from 'react'
import { RunWebhookDelivery } from '@/utils/api'

// A run webhook's last deliveries, newest first: what was sent, how the URL
// answered and how many tries it took.
const KIND: Record<string, string> = { ai: 'AI', http: 'HTTP', enrichment: 'Enrichment', setup: 'Setup' }

const when = (iso: string) => new Date(iso).toLocaleString()

function result(d: RunWebhookDelivery): { text: string; tone: string } {
  if (d.state === 'delivered') return { text: `Delivered (${d.response_code})`, tone: 'text-green-700' }
  if (d.state === 'failed') return { text: 'Failed', tone: 'text-red-700' }
  return { text: d.tries > 0 ? 'Trying again soon' : 'Waiting to send', tone: 'text-gray-600' }
}

export const RunWebhookDeliveries: React.FC<{ deliveries: RunWebhookDelivery[] | null }> = ({ deliveries }) => {
  if (deliveries === null) return <p className="text-sm text-gray-500 py-2">Loading deliveries…</p>
  if (deliveries.length === 0) {
    return <p className="text-sm text-gray-500 py-2">Nothing sent yet. Use Send a test to try it.</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" data-testid="run-webhook-deliveries">
        <thead>
          <tr className="text-left text-gray-500 border-b border-gray-200">
            <th className="py-2 pr-3 font-medium">Sent</th>
            <th className="py-2 pr-3 font-medium">Notice</th>
            <th className="py-2 pr-3 font-medium">Result</th>
            <th className="py-2 pr-3 font-medium">Tries</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.map(d => {
            const r = result(d)
            return (
              <tr key={d.id} className="border-b border-gray-100 align-top">
                <td className="py-2 pr-3 whitespace-nowrap text-gray-700">{when(d.created_at)}</td>
                <td className="py-2 pr-3 text-gray-700">
                  {d.event === 'test' ? 'Test'
                    : `${KIND[d.kind ?? ''] ?? 'Run'} run ${d.run_status ?? ''}`}
                  {d.run_id && <code className="block text-gray-400 break-all">{d.run_id}</code>}
                </td>
                <td className={`py-2 pr-3 ${r.tone}`}>
                  {r.text}
                  {d.error && <span className="block text-gray-500">{d.error}</span>}
                </td>
                <td className="py-2 pr-3 text-gray-700">{d.tries}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
