import React, { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import Modal from '@/components/Modal'
import { toastBlocked } from '@/components/sheet/blockedToast'
import {
  dedupeAPI, type AutoDedupeView, type CleanColumnView, type ColumnType, type DedupeRemoveResult,
} from '@/utils/api'
import { plural } from '@/lib/utils'
import { useDedupeForm } from './useDedupeForm'
import { useAutoDedupeForm } from './useAutoDedupeForm'
import { DedupeColumnsPicker, DedupeKeepPicker } from './DedupeChoices'
import { DedupeCheckView } from './DedupeCheckView'
import { AutoDedupePanel } from './AutoDedupePanel'

export type DedupeTab = 'now' | 'auto'

interface Props {
  isOpen: boolean
  onClose: () => void
  // The tab it opens on.
  tab: DedupeTab
  sheetId: string
  columns: string[]
  columnTypes: Record<string, ColumnType>
  cleanColumns: Record<string, CleanColumnView>
  // The sheet's auto-dedupe (null: off), and what saving it changed it to.
  autoDedupe: AutoDedupeView | null
  onAutoDedupeChanged: (view: AutoDedupeView | null) => void
  // The autosave barrier: pending edits land before rows are matched. False: they couldn't.
  onBeforeRemove: () => Promise<boolean>
  onRemoved: (result: DedupeRemoveResult) => void
  // The removal failed past its checks (a server error, a timeout): rows may be partly gone. Reload.
  onStoppedPartWay: () => void
}

const TABS: ReadonlyArray<{ id: DedupeTab; label: string }> = [
  { id: 'now', label: 'Remove now' }, { id: 'auto', label: 'As rows arrive' },
]

// Remove duplicates: pick the columns rows must match on and which row stays,
// see what would go, then remove it (to the trash). Or keep it that way as
// rows arrive: auto-dedupe. Free: nothing leaves Cubex.
export const RemoveDuplicatesModal: React.FC<Props> = props => {
  const { isOpen, onClose, sheetId, columns, cleanColumns, onBeforeRemove, onRemoved, onStoppedPartWay } = props
  const [tab, setTab] = useState<DedupeTab>(props.tab)
  useEffect(() => { if (isOpen) setTab(props.tab) }, [isOpen, props.tab])
  const f = useDedupeForm({ sheetId, columns, cleanColumns, open: isOpen && tab === 'now' })
  const auto = useAutoDedupeForm({
    sheetId, columns, columnTypes: props.columnTypes, cleanColumns, current: props.autoDedupe,
    open: isOpen && tab === 'auto', onChanged: props.onAutoDedupeChanged,
  })
  const [removing, setRemoving] = useState(false)
  const result = f.check.loading ? null : f.check.result
  const count = result?.duplicateRows ?? 0
  const canRemove = !!f.body && !!result && !f.check.error && count > 0 && !result.blockedBy && !removing
  const busy = removing || auto.saving

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
    <Modal isOpen={isOpen} onClose={() => { if (!busy) onClose() }} panelClassName="max-w-2xl w-full">
      <div className="p-6 border-b border-gray-200">
        <h3 className="text-title text-gray-900">Remove duplicates</h3>
        <p className="text-sm text-gray-600 mt-1">
          {tab === 'now'
            ? 'Rows that match on every column you pick are duplicates, and one row of each group stays.'
            : 'Keep one row per key as rows arrive: from a webhook, a CSV import, the API, or typed into the sheet.'}
          {' '}Free: no AI, no credits.
        </p>
        <div className="flex border border-gray-300 w-fit mt-4" role="tablist" aria-label="Remove duplicates">
          {TABS.map(t => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
              disabled={busy} data-testid={`dedupe-tab-${t.id}`}
              className={`px-3 py-1.5 text-sm ${tab === t.id ? 'bg-cube-black text-white' : 'bg-white text-gray-700'}`}>
              {t.label}{t.id === 'auto' && props.autoDedupe ? ' · On' : ''}
            </button>
          ))}
        </div>
      </div>
      {tab === 'auto' ? (
        <div className="p-6">
          <AutoDedupePanel form={auto} view={props.autoDedupe} sheetId={sheetId} onRemoveNow={() => setTab('now')} />
        </div>
      ) : columns.length === 0 ? (
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
          {tab === 'now' ? "The whole sheet is checked; filters don't apply. " : ''}
          Removed rows go to the trash, where you can restore them.
        </p>
        <div className="flex gap-3 flex-shrink-0">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            {tab === 'auto' && !auto.changed ? 'Close' : 'Cancel'}
          </button>
          {tab === 'auto' ? (
            <>
              {props.autoDedupe && (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => void auto.turnOff()}
                  data-testid="auto-dedupe-off">Turn off</button>
              )}
              <button type="button" className="btn-primary" data-testid="auto-dedupe-save"
                disabled={busy || !auto.changed || !auto.column} onClick={() => void auto.save()}>
                {auto.saving ? 'Saving…' : props.autoDedupe ? 'Save' : 'Turn on'}
              </button>
            </>
          ) : (
            <button type="button" className="btn-danger" disabled={!canRemove} onClick={() => void remove()}
              data-testid="dedupe-remove">
              {removing ? 'Removing…' : count > 0 ? `Remove ${plural(count, 'row')}` : 'Remove'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}
