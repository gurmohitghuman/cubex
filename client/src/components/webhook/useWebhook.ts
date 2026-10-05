import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import {
  webhooksAPI, type WebhookSource, type WebhookMapping, type WebhookDelivery,
} from '@/utils/api/webhooks'

// Data + actions for the webhook drawer, extracted so WebhookDrawer stays under
// the 200-line cap. Loads source + mappings + recent deliveries for a sheet and
// exposes the mutating actions (create/rotate/enable/delete/map).
export function useWebhook(sheetId: string | null, isOpen: boolean) {
  const [loading, setLoading] = useState(false)
  const [source, setSource] = useState<WebhookSource | null>(null)
  const [mappings, setMappings] = useState<WebhookMapping[]>([])
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([])
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!sheetId) return
    setLoading(true)
    try {
      const state = await webhooksAPI.get(sheetId)
      setSource(state.source)
      setMappings(state.mappings)
      if (state.source) {
        const { deliveries } = await webhooksAPI.recentDeliveries(sheetId)
        setDeliveries(deliveries)
      } else {
        setDeliveries([])
      }
    } catch {
      toast.error('Could not load webhook.')
    } finally {
      setLoading(false)
    }
  }, [sheetId])

  useEffect(() => { if (isOpen) void refresh() }, [isOpen, refresh])

  // While the drawer is open and a webhook exists, poll deliveries so a NEWLY
  // arrived event shows up in the sample picker / deliveries list without the
  // user closing and reopening. Source has no count here — we just re-fetch the
  // recent list every few seconds; cheap (capped to 25 rows) and only while open.
  // Stored in state via setDeliveries; the pinned sample in WebhookMapping won't
  // jump because it keys off the user's selected index, not the array identity.
  const hasSource = !!source
  useEffect(() => {
    if (!isOpen || !sheetId || !hasSource) return
    let cancelled = false
    const tick = async () => {
      try {
        const { deliveries } = await webhooksAPI.recentDeliveries(sheetId)
        if (!cancelled) setDeliveries(deliveries)
      } catch { /* transient; next tick retries */ }
    }
    const t = setInterval(tick, 5000)
    return () => { cancelled = true; clearInterval(t) }
  }, [isOpen, sheetId, hasSource])

  const create = useCallback(async () => {
    if (!sheetId) return
    setBusy(true)
    try {
      const state = await webhooksAPI.create(sheetId)
      setSource(state.source)
      setMappings(state.mappings)
      toast.success('Webhook created. Copy the URL.')
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not create webhook.')
    } finally { setBusy(false) }
  }, [sheetId])

  const rotate = useCallback(async () => {
    if (!sheetId) return
    setBusy(true)
    try {
      const { source } = await webhooksAPI.rotate(sheetId)
      setSource(source)
      toast.success('New URL issued. The old one no longer works.')
    } catch { toast.error('Rotate failed.') } finally { setBusy(false) }
  }, [sheetId])

  const setEnabled = useCallback(async (enabled: boolean) => {
    if (!sheetId) return
    try {
      const { source } = await webhooksAPI.setEnabled(sheetId, enabled)
      setSource(source)
    } catch { toast.error('Could not update.') }
  }, [sheetId])

  const remove = useCallback(async () => {
    if (!sheetId) return
    setBusy(true)
    try {
      await webhooksAPI.remove(sheetId)
      setSource(null); setMappings([]); setDeliveries([])
      toast.success('Webhook deleted.')
    } catch { toast.error('Delete failed.') } finally { setBusy(false) }
  }, [sheetId])

  const addMapping = useCallback(async (jsonPath: string, columnName: string) => {
    if (!sheetId) return
    try {
      const { mappings } = await webhooksAPI.addMapping(sheetId, jsonPath, columnName)
      setMappings(mappings)
      toast.success(`Mapped "${columnName}". Applies to future events.`)
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not add mapping.')
    }
  }, [sheetId])

  const deleteMapping = useCallback(async (mappingId: string) => {
    if (!sheetId) return
    try {
      const { mappings } = await webhooksAPI.deleteMapping(sheetId, mappingId)
      setMappings(mappings)
    } catch { toast.error('Could not remove mapping.') }
  }, [sheetId])

  return {
    loading, busy, source, mappings, deliveries,
    refresh, create, rotate, setEnabled, remove, addMapping, deleteMapping,
  }
}
