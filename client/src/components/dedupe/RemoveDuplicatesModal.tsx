import React, { useState } from 'react'
import toast from 'react-hot-toast'
import Modal from '@/components/Modal'
import { toastBlocked } from '@/components/sheet/blockedToast'
import { dedupeAPI, type CleanColumnView, type DedupeRemoveResult } from '@/utils/api'
import { plural } from '@/lib/utils'
import { useDedupeForm } from './useDedupeForm'
import { DedupeColumnsPicker, DedupeKeepPicker } from './DedupeChoices'
import { DedupeCheckView } from './DedupeCheckView'

interface Props {
  isOpen: boolean
  onClose: () => void
  sheetId: string
  columns: string[]
  cleanColumns: Record<string, CleanColumnView>
  // The autosave barrier: pending edits land before rows are matched. False: they couldn't.
  onBeforeRemove: () => Promise<boolean>
  onRemoved: (result: DedupeRemoveResult) => void
  // The removal failed past its checks (a server error, a timeout): rows may be partly gone. Reload.
  onStoppedPartWay: () => void
}

// Remove duplicates: pick the columns rows must match on and which row stays,
// see what would go, then remove it for good. Free: nothing leaves Cubex.
export const RemoveDuplicatesModal: React.FC<Props> = props => {
  const { isOpen, onClose, sheetId, columns, cleanColumns, onBeforeRemove, onRemoved, onStoppedPartWay } = props
  const f = useDedupeForm({ sheetId, columns, cleanColumns, open: isOpen })
  const [removing, setRemoving] = useState(false)
  const result = f.check.loading ? null : f.check.result
  const count = result?.duplicateRows ?? 0
  const canRemove = !!f.body && !!result && !f.check.error && count > 0 && !result.blockedBy && !removing

  const remove = async () => {
    if (!f.body) return
    setRemoving(true)
    try {
      if (!(await onBeforeRemove())) {
        toast.error("Couldn't save your pending edits, so nothing was removed. Try again.")
        return
      }
      onRemoved(await dedupeAPI.remove(sheetId, f.body))
    } catch (e: any) {
      const status: number | undefined = e?.response?.status
      // 409: a run or another job holds the sheet; 400/404: the choices no longer fit. Nothing was removed.
      if (status === 409) toastBlocked(e, "Couldn't remove duplicates", { onCancelled: f.recheck })
      else if (status === 400 || status === 404) toast.error(e?.response?.data?.error || "Couldn't remove duplicates.")
      else {
        toast.error('Removing duplicates stopped part-way, so some rows may already be gone. The sheet was reloaded.')
        onStoppedPartWay()
      }
    } finally {
      setRemoving(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={() => { if (!removing) onClose() }} panelClassName="max-w-2xl w-full">
      <div className="p-6 border-b border-gray-200">
        <h3 className="text-title text-gray-900">Remove duplicates</h3>
        <p className="text-sm text-gray-600 mt-1">
          Rows that match on every column you pick are duplicates, and one row of each group stays. Free: no AI,
          no credits.
        </p>
      </div>
      {columns.length === 0 ? (
        <p className="p-6 text-sm text-gray-600">Add a column with values first.</p>
      ) : (
        <div className="p-6 space-y-5" data-testid="dedupe-form">
          <DedupeColumnsPicker form={f} />
          <DedupeKeepPicker form={f} />
          <DedupeCheckView state={f.check} ready={!!f.body} />
        </div>
      )}
      <div className="px-6 pb-6 flex items-center justify-between gap-4">
        <p className="text-xs text-gray-500">
          The whole sheet is checked; filters don&apos;t apply. Removed rows can&apos;t be brought back.
        </p>
        <div className="flex gap-3 flex-shrink-0">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={removing}>Cancel</button>
          <button type="button" className="btn-danger" disabled={!canRemove} onClick={() => void remove()}
            data-testid="dedupe-remove">
            {removing ? 'Removing…' : count > 0 ? `Remove ${plural(count, 'row')}` : 'Remove'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
