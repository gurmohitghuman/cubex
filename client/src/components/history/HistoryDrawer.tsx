import React, { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import {
  ArchiveRestore, ArrowDownUp, Columns, Eye, History, Loader2, Pencil, Play, Settings2, Trash2, Upload, Webhook,
} from 'lucide-react'
import { Drawer, DrawerBody, DrawerHeader } from '@/components/Drawer'
import { historyAPI, trashAPI, type SheetChange } from '@/utils/api'
import { restoredText } from '@/components/trash/trash-copy'

interface Props { isOpen: boolean; onClose: () => void; sheetId: string }

type Icon = React.FC<{ className?: string }>
const ICONS: Array<[RegExp, Icon]> = [
  [/^column_|_column$|answer_field|list_fields/, Columns],
  [/^run|auto_run|setup_used|default_model/, Play],
  [/^view_/, Eye],
  [/^webhook/, Webhook],
  [/^rows_deleted|^sheet_deleted|duplicates_removed|rows_moved_out/, Trash2],
  [/restored/, ArchiveRestore],
  [/rows_imported|rows_moved_in/, Upload],
  [/rows_sorted/, ArrowDownUp],
  [/sheet_renamed|description/, Pencil],
]
const iconOf = (action: string): Icon => ICONS.find(([re]) => re.test(action))?.[1] ?? Settings2

const dayOf = (iso: string): string => {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86_400_000)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

// The sheet's History: its setup changes and big row changes, newest first,
// with who made them (the app, an access token, Cubex). A line about rows
// still in the trash can put them back.
export const HistoryDrawer: React.FC<Props> = ({ isOpen, onClose, sheetId }) => {
  const [changes, setChanges] = useState<SheetChange[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [days, setDays] = useState(90)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<number | null>(null)

  const load = useCallback(async (before?: number) => {
    setLoading(true)
    try {
      const page = await historyAPI.read(sheetId, { before })
      setChanges(prev => (before === undefined ? page.changes : [...prev, ...page.changes]))
      setNext(page.next_before)
      setDays(page.kept_days)
      setError(null)
    } catch (e: any) {
      setError(e?.response?.data?.error || "Couldn't read the history")
    } finally { setLoading(false) }
  }, [sheetId])

  useEffect(() => { if (isOpen) void load() }, [isOpen, load])

  const restore = async (trashId: number) => {
    setRestoring(trashId)
    try {
      const { results } = await trashAPI.restore([trashId])
      const r = results[0]
      if (r?.restored) toast.success(restoredText(r), { duration: 6000 })
      else toast.error(r?.error ?? "Couldn't restore it")
      await load()
    } catch (e: any) {
      toast.error(e?.response?.data?.error || "Couldn't restore it")
    } finally { setRestoring(null) }
  }

  let lastDay = ''
  return (
    <Drawer isOpen={isOpen} onClose={onClose} panelClassName="max-w-lg">
      <DrawerHeader icon={<History className="h-5 w-5 text-gray-700" />} title="History" onClose={onClose}
        description={`What changed on this sheet in the last ${days} days, and who changed it.`} />
      <DrawerBody>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!error && changes.length === 0 && !loading && (
          <p className="text-sm text-gray-600" data-testid="history-empty">No changes yet.</p>
        )}
        <ul className="space-y-1" data-testid="history-list">
          {changes.map(c => {
            const day = dayOf(c.at)
            const header = day !== lastDay ? day : null
            lastDay = day
            const Glyph = iconOf(c.action)
            const trashId = typeof c.detail?.trash_id === 'number' ? c.detail.trash_id : null
            return (
              <React.Fragment key={c.id}>
                {header && <li className="meta-label pt-3 pb-1">{header}</li>}
                <li className="flex items-start gap-2.5 py-1.5" data-testid="history-line">
                  <Glyph className="h-3.5 w-3.5 mt-0.5 text-gray-500 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-900 break-words">{c.summary}</p>
                    <p className="text-xs text-gray-500">{timeOf(c.at)} · {c.by}</p>
                  </div>
                  {/* Moved rows are still in the other sheet: their restore (with its note) is in the trash. */}
                  {trashId !== null && c.in_trash && c.action !== 'rows_moved_out' && (
                    <button type="button" className="text-xs underline text-gray-700 whitespace-nowrap"
                      disabled={restoring !== null} onClick={() => void restore(trashId)}
                      data-testid="history-restore">
                      {restoring === trashId ? 'Restoring…' : 'Restore'}
                    </button>
                  )}
                </li>
              </React.Fragment>
            )
          })}
        </ul>
        {loading && (
          <p className="text-sm text-gray-600 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />
            Loading…</p>
        )}
        {next !== null && !loading && (
          <button type="button" className="btn-secondary" onClick={() => void load(next)}>Load older</button>
        )}
        <p className="text-xs text-gray-500 pt-2 border-t border-gray-200">
          Cell edits aren&apos;t listed. Deleted rows, sheets and tables are in the trash.
        </p>
      </DrawerBody>
    </Drawer>
  )
}
