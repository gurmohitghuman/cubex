import { useState } from 'react'
import toast from 'react-hot-toast'
import { waterfallAPI, type WaterfallRunInput } from '@/utils/api/waterfall'

// An edit's Save: the drawer's setup becomes the column's and nothing runs (saveOnly). The server makes every
// check a run makes; its refusal shows in the drawer's error line (setError), as a start's does.
export function useWaterfallSave(sheetId: string, onSaved: () => void, setError: (e: string | null) => void) {
  const [saving, setSaving] = useState(false)
  const save = async (input: WaterfallRunInput) => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await waterfallAPI.start(sheetId, { ...input, saveOnly: true })
      toast.success('Setup saved. Nothing ran.')
      onSaved()
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Couldn\'t save the setup.')
    } finally { setSaving(false) }
  }
  return { save, saving }
}
