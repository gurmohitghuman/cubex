import React, { useEffect, useMemo, useState } from 'react'
import { Trash2, ChevronDown } from 'lucide-react'
import { JsonTree } from '../json-mapping/JsonTree'
import type { WebhookMapping as Mapping, WebhookDelivery } from '@/utils/api/webhooks'

// Mapping section: pick a sample delivery, click fields in the JsonTree to map
// them into columns, see existing mappings. The tree builds bracket-safe paths
// (shared json-mapping/jsonPath) that the server extractor resolves identically.
export function WebhookMapping({
  deliveries, mappings, onPick, onDeleteMapping,
}: {
  deliveries: WebhookDelivery[]
  mappings: Mapping[]
  onPick: (jsonPath: string, columnName: string) => void
  onDeleteMapping: (mappingId: string) => void
}) {
  const samples = useMemo(() => deliveries.filter(d => d.retained && d.payload != null), [deliveries])

  // PINNED sample: track by delivery ID, not index, so when the deliveries list
  // refreshes (live poll) a newer event doesn't yank the tree out from under the
  // user. Default to the newest; if the pinned one ages out of the list, fall
  // back to the newest. A "newer sample available" chip offers an explicit swap.
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  useEffect(() => {
    if (samples.length === 0) { setPinnedId(null); return }
    if (!pinnedId || !samples.some(s => s.id === pinnedId)) setPinnedId(samples[0].id)
  }, [samples, pinnedId])
  const sample = samples.find(s => s.id === pinnedId) ?? samples[0]
  const newerAvailable = samples.length > 0 && sample && samples[0].id !== sample.id

  // Index existing mappings by path so the tree shows ✓ on already-mapped leaves.
  const mappingByPath = useMemo(() => {
    const m = new Map<string, string>()
    for (const x of mappings) m.set(x.jsonPath, x.columnName)
    return m
  }, [mappings])

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">Map fields → columns</h3>

      {samples.length === 0 ? (
        <p className="text-sm text-gray-500">
          No event with a mappable payload yet. Send a test event, then pick fields here.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            {samples.length > 1 && (
              <>
                <label className="text-xs text-gray-500">Sample</label>
                <div className="relative">
                  <select
                    value={sample?.id ?? ''}
                    onChange={(e) => setPinnedId(e.target.value)}
                    className="input text-xs pr-6 py-1 appearance-none"
                  >
                    {samples.map((d, i) => (
                      <option key={d.id} value={d.id}>
                        {new Date(d.receivedAt + 'Z').toLocaleString()} {i === 0 ? '(newest)' : ''}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="h-3 w-3 absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                </div>
              </>
            )}
            {newerAvailable && (
              <button
                type="button"
                onClick={() => setPinnedId(samples[0].id)}
                className="text-xs text-cube-black underline hover:no-underline"
              >
                Newer sample available. Use it
              </button>
            )}
          </div>

          <div className="rounded border border-gray-200 bg-white p-2 text-xs font-mono overflow-x-auto max-h-72 overflow-y-auto">
            <JsonTree value={sample.payload} path="$" mappingByPath={mappingByPath} onPick={onPick} />
          </div>
          <p className="text-xs text-gray-500">Mappings apply to <strong>future</strong> deliveries only.</p>
        </>
      )}

      {mappings.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-gray-600">Mapped columns</h4>
          {mappings.map(m => (
            <div key={m.id} className="flex items-center justify-between rounded border border-gray-100 bg-gray-50 px-2 py-1 text-xs">
              <div className="min-w-0">
                <span className="font-medium text-gray-800">{m.columnName}</span>
                <span className="text-gray-400 mx-1">←</span>
                <code className="text-gray-600">{m.jsonPath}</code>
              </div>
              <button
                type="button"
                onClick={() => onDeleteMapping(m.id)}
                className="text-gray-400 hover:text-red-600 flex-shrink-0"
                title="Remove mapping (keeps the column)"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
