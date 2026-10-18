import React, { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Copy, KeyRound, Loader2, RefreshCw, Send, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { RunWebhook, RunWebhookDelivery, runWebhooksAPI } from '@/utils/api'
import { ConfirmDialog } from '../ConfirmDialog'
import { RunWebhookSecret } from './RunWebhookSecret'
import { RunWebhookDeliveries } from './RunWebhookDeliveries'

interface Props {
  webhook: RunWebhook
  reload: () => Promise<void>
}

const errorOf = (e: any, fallback: string) => e?.response?.data?.error || fallback

// One run webhook: its URL and id, who it hears about, a test, a new secret,
// delete, and its delivery log.
export const RunWebhookCard: React.FC<Props> = ({ webhook, reload }) => {
  const [open, setOpen] = useState(false)
  const [deliveries, setDeliveries] = useState<RunWebhookDelivery[] | null>(null)
  const [busy, setBusy] = useState<'test' | 'secret' | 'delete' | 'every' | null>(null)
  const [confirm, setConfirm] = useState<'secret' | 'delete' | null>(null)
  const [secret, setSecret] = useState<string | null>(null)

  const loadDeliveries = async () => {
    try { setDeliveries(await runWebhooksAPI.deliveries(webhook.id)) }
    catch (e) { toast.error(errorOf(e, 'Failed to load deliveries')) }
  }
  useEffect(() => { if (open) loadDeliveries() }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (what: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(what)
    try { await fn() } finally { setBusy(null) }
  }
  const sendTest = () => act('test', async () => {
    try {
      const d = await runWebhooksAPI.test(webhook.id)
      if (d.state === 'delivered') toast.success(`Test delivered: the URL answered ${d.response_code}`)
      else toast.error(`Test not delivered. ${d.error ?? ''}`.trim())
      setOpen(true)
      await Promise.all([loadDeliveries(), reload()])
    } catch (e) { toast.error(errorOf(e, 'Failed to send the test')) }
  })
  const toggleEvery = (everyRun: boolean) => act('every', async () => {
    try { await runWebhooksAPI.update(webhook.id, { every_run: everyRun }); await reload() }
    catch (e) { toast.error(errorOf(e, 'Failed to change the webhook')) }
  })
  const makeSecret = () => act('secret', async () => {
    try { setSecret(await runWebhooksAPI.newSecret(webhook.id)) }
    catch (e) { toast.error(errorOf(e, 'Failed to make a new secret')) }
  })
  const remove = () => act('delete', async () => {
    try { await runWebhooksAPI.remove(webhook.id); toast.success('Webhook deleted'); await reload() }
    catch (e) { toast.error(errorOf(e, 'Failed to delete the webhook')) }
  })
  const copyId = async () => {
    try { await navigator.clipboard.writeText(webhook.id); toast.success('Webhook id copied') }
    catch { toast.error('Copy failed. Select the id and copy it yourself') }
  }

  const iconBtn = 'p-2 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors '
    + 'disabled:opacity-50'
  return (
    <div className="border border-gray-200 rounded-lg" data-testid="run-webhook-card">
      <ConfirmDialog isOpen={confirm === 'delete'} title="Delete this webhook?" isDestructive confirmText="Delete"
        message={`Cubex stops sending to ${webhook.url}, and its delivery log is deleted. This can't be undone.`}
        onConfirm={() => { setConfirm(null); remove() }} onCancel={() => setConfirm(null)} />
      <ConfirmDialog isOpen={confirm === 'secret'} title="Make a new secret?" confirmText="Make a new secret"
        message="The current secret stops working at once: your receiver needs the new one to check signatures."
        onConfirm={() => { setConfirm(null); makeSecret() }} onCancel={() => setConfirm(null)} />
      {secret && (
        <div className="fixed inset-0 bg-cube-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6 space-y-4" role="dialog">
            <h3 className="text-title text-gray-900">New secret</h3>
            <RunWebhookSecret secret={secret} />
            <button onClick={() => setSecret(null)} className="btn-primary w-full">Done</button>
          </div>
        </div>
      )}

      <div className="flex items-start justify-between p-4 gap-3">
        <div className="min-w-0">
          <p className="font-medium text-gray-900 break-all" data-testid="run-webhook-card-url">{webhook.url}</p>
          <button onClick={copyId} title="Copy the id runs pass as webhook_id"
            className="mt-1 inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800">
            <code>{webhook.id}</code><Copy className="h-3 w-3" />
          </button>
          <label className="flex items-center gap-2 mt-2 text-sm text-gray-700">
            <input type="checkbox" checked={webhook.every_run} disabled={busy === 'every'}
              data-testid="run-webhook-card-every" onChange={(e) => toggleEvery(e.target.checked)} />
            Every run
            <span className="text-xs text-gray-500">
              {webhook.every_run ? '' : '(only runs started with this id)'}
            </span>
          </label>
        </div>
        <div className="flex items-center shrink-0">
          <button onClick={sendTest} disabled={busy !== null} className={iconBtn} title="Send a test"
            data-testid="run-webhook-test">
            {busy === 'test' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
          <button onClick={() => setConfirm('secret')} disabled={busy !== null} className={iconBtn} title="New secret">
            <KeyRound className="h-4 w-4" />
          </button>
          <button onClick={() => setConfirm('delete')} disabled={busy !== null} className={iconBtn} title="Delete">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="border-t border-gray-100 px-4 py-2">
        <div className="flex items-center justify-between">
          <button onClick={() => setOpen(o => !o)} data-testid="run-webhook-log-toggle"
            className="flex items-center gap-1 text-sm text-gray-700 hover:text-gray-900">
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}Recent deliveries
          </button>
          {open && (
            <button onClick={loadDeliveries} className={iconBtn} title="Refresh">
              <RefreshCw className="h-3 w-3" />
            </button>
          )}
        </div>
        {open && <RunWebhookDeliveries deliveries={deliveries} />}
      </div>
    </div>
  )
}
