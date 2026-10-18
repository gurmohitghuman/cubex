import React, { useEffect, useState } from 'react'
import { Plus, Webhook } from 'lucide-react'
import toast from 'react-hot-toast'
import { RunWebhook, runWebhooksAPI } from '@/utils/api'
import { TabLoading, TabLoadFailed } from './TabLoading'
import { RunWebhookCard } from './RunWebhookCard'
import { RunWebhookCreateModal } from './RunWebhookCreateModal'

// Run webhooks: URLs Cubex tells, with a signed POST, when a run finishes.
export const SettingsRunWebhooksTab: React.FC = () => {
  const [hooks, setHooks] = useState<RunWebhook[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [adding, setAdding] = useState(false)

  const load = async () => {
    try {
      setHooks(await runWebhooksAPI.list())
      setLoadFailed(false)
    } catch (error) {
      toast.error('Failed to load run webhooks')
      console.error('Load run webhooks error:', error)
      setLoadFailed(true)
    }
  }
  useEffect(() => { load() }, [])

  return (
    <div className="card mb-6">
      <div className="p-6 border-b border-gray-200">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start space-x-3">
            <div className="bg-gray-100 p-2 rounded-sm"><Webhook className="h-5 w-5 text-cube-black" /></div>
            <div>
              <h3 className="text-title text-gray-900">Run webhooks</h3>
              <p className="text-sm text-gray-600">
                When an AI, HTTP, enrichment or setup run finishes, Cubex sends a POST to each URL here with the
                run&apos;s id, kind, sheet, status and time, so a script or an automation can carry on without
                checking again and again.
              </p>
            </div>
          </div>
          <button onClick={() => setAdding(true)} data-testid="run-webhook-add"
            className="btn-primary flex items-center space-x-2 text-sm px-4 py-2 shrink-0">
            <Plus className="h-4 w-4" /><span>Add webhook</span>
          </button>
        </div>
        <ul className="mt-4 ml-11 text-xs text-gray-600 list-disc space-y-1">
          <li>Each POST has an X-Cubex-Signature header: sha256= and the HMAC-SHA256 of the body with the
            webhook&apos;s secret. Check it to know the POST came from Cubex.</li>
          <li>A URL that doesn&apos;t answer with a 2xx is tried 3 times. A notice can still be lost while your URL is
            down, so check the run&apos;s status before you rely on it.</li>
          <li>Agents and scripts pass a webhook&apos;s id as webhook_id when they start a run to hear about that
            run.</li>
        </ul>
      </div>
      <div className="p-6">
        {hooks === null
          ? (loadFailed ? <TabLoadFailed what="run webhooks" onRetry={load} /> : <TabLoading />)
          : hooks.length === 0 ? (
            <div className="text-center py-8">
              <Webhook className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <h4 className="text-lg font-medium text-gray-900 mb-2">No run webhooks yet</h4>
              <p className="text-gray-500">Add a URL to hear when your runs finish.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {hooks.map(h => <RunWebhookCard key={h.id} webhook={h} reload={load} />)}
            </div>
          )}
      </div>
      <RunWebhookCreateModal isOpen={adding} onClose={() => setAdding(false)} onCreated={load} />
    </div>
  )
}
