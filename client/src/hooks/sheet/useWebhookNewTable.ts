import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { tablesAPI } from '@/utils/api'

// Backs the webhook drawer's "Create a new table for the webhook" option:
// create a fresh table and open it.
export function useWebhookNewTable() {
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)

  const createAndOpen = useCallback(async () => {
    if (creating) return // guard against a double-click issuing two table creates
    setCreating(true)
    try {
      // Table names are unique per account: take the first free "Webhook",
      // "Webhook 2", ... (a fixed name failed from the second use on).
      const taken = new Set((await tablesAPI.getAll()).map(t => t.name))
      let name = 'Webhook'
      for (let n = 2; taken.has(name); n++) name = `Webhook ${n}`
      const table = await tablesAPI.create(name)
      navigate(`/table/${table.id}`)
      toast.success('New table created. Open the Webhook button here to set it up.')
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not create a table.')
      setCreating(false) // re-enable on failure; on success we navigate away
    }
  }, [navigate, creating])

  return { onCreateNewTable: createAndOpen, creatingTable: creating }
}
