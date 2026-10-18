import React from 'react'
import toast from 'react-hot-toast'
import { trashAPI } from '@/utils/api'
import { restoredText } from './trash-copy'

// A delete's success toast with "Restore" when it went to the trash: one click
// puts it back (services/trash-restore*.ts), then `onRestored` reloads what shows it.
export function toastDeleted(
  message: string, trashId: number | null | undefined,
  opts: { id?: string; onRestored?: () => void } = {},
): void {
  if (!trashId) { toast.success(message, opts.id ? { id: opts.id } : undefined); return }
  const restore = async (toastId: string) => {
    toast.dismiss(toastId)
    const busy = toast.loading('Restoring…')
    try {
      const { results } = await trashAPI.restore([trashId])
      const r = results[0]
      if (r?.restored) {
        toast.success(restoredText(r), { id: busy, duration: 6000 })
        opts.onRestored?.()
      } else {
        toast.error(r?.error ?? "Couldn't restore it", { id: busy })
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.error || "Couldn't restore it", { id: busy })
    }
  }
  toast.success(t => (
    <span className="flex items-start gap-3" data-testid="deleted-toast">
      <span>{message}</span>
      <button type="button" className="underline whitespace-nowrap" onClick={() => void restore(t.id)}
        data-testid="deleted-toast-restore">Restore</button>
    </span>
  ), { id: opts.id, duration: 10000 })
}
