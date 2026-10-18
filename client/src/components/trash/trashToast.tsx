import React from 'react'
import toast from 'react-hot-toast'
import { trashAPI } from '@/utils/api'
import { restoredText } from './trash-copy'
import { TRASH_RESTORE_PICK_MAX } from '@/lib/constants'

// Picked rows of a batch, TRASH_RESTORE_PICK_MAX a call: what the last call
// said, counting every row put back.
async function restorePicked(trashId: number, seqs: number[]) {
  let got = await trashAPI.restoreRows(trashId, seqs.slice(0, TRASH_RESTORE_PICK_MAX))
  let rows = got.rows ?? 0
  for (let i = TRASH_RESTORE_PICK_MAX; i < seqs.length; i += TRASH_RESTORE_PICK_MAX) {
    got = await trashAPI.restoreRows(trashId, seqs.slice(i, i + TRASH_RESTORE_PICK_MAX))
    rows += got.rows ?? 0
  }
  return { ...got, rows }
}

// A delete's success toast with "Restore" when it went to the trash: one click
// puts it back (services/trash-restore*.ts), then `onRestored` reloads what shows it.
// seqs: only those rows of the batch (auto-dedupe's batch holds a whole day's).
export function toastDeleted(
  message: string, trashId: number | null | undefined,
  opts: { id?: string; onRestored?: () => void; seqs?: number[] } = {},
): void {
  if (!trashId) { toast.success(message, opts.id ? { id: opts.id } : undefined); return }
  const restore = async (toastId: string) => {
    toast.dismiss(toastId)
    const busy = toast.loading('Restoring…')
    try {
      const r = opts.seqs
        ? { trash_id: trashId, restored: await restorePicked(trashId, opts.seqs) }
        : (await trashAPI.restore([trashId])).results[0]
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
