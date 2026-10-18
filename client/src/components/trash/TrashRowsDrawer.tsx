import React, { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { ArchiveRestore, Download, Loader2, Rows, Search } from 'lucide-react'
import { Drawer, DrawerBody, DrawerHeader } from '@/components/Drawer'
import { plural } from '@/lib/utils'
import { trashAPI, type TrashEntry, type TrashRow } from '@/utils/api'
import { restoredText, titleOf } from './trash-copy'

interface Props {
  entry: TrashEntry | null
  onClose: () => void
  onRestored: () => void
  onDownload: (e: TrashEntry) => void
}

const SHOWN_COLUMNS = 8

// Inside a batch of deleted rows: its rows as they were, a page at a time, a
// search in one column (or any cell), and restoring the rows picked.
export const TrashRowsDrawer: React.FC<Props> = ({ entry, onClose, onRestored, onDownload }) => {
  const [column, setColumn] = useState('')
  const [text, setText] = useState('')
  const [rows, setRows] = useState<TrashRow[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [restoring, setRestoring] = useState(false)
  const columns = entry?.columns ?? []

  const load = async (after?: number) => {
    if (!entry) return
    setLoading(true)
    try {
      const page = await trashAPI.rows(entry.id, {
        after, column: column || undefined, contains: text.trim() || undefined,
      })
      setRows(prev => (after === undefined ? page.rows : [...prev, ...page.rows]))
      setNext(page.next_after)
    } catch (e: any) {
      toast.error(e?.response?.data?.error || "Couldn't read the rows")
    } finally { setLoading(false) }
  }

  useEffect(() => {
    setRows([]); setPicked(new Set()); setNext(null)
    const t = setTimeout(() => void load(), text ? 300 : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.id, column, text])

  const toggle = (seq: number) => setPicked(prev => {
    const s = new Set(prev)
    if (s.has(seq)) s.delete(seq); else s.add(seq)
    return s
  })
  const restorePicked = async () => {
    if (!entry || picked.size === 0) return
    setRestoring(true)
    try {
      const got = await trashAPI.restoreRows(entry.id, [...picked])
      toast.success(restoredText({ trash_id: entry.id, restored: got }, entry), { duration: 6000 })
      onRestored()
      setPicked(new Set())
      await load()
    } catch (e: any) {
      toast.error(e?.response?.data?.error || "Couldn't restore the rows")
    } finally { setRestoring(false) }
  }
  const shown = columns.slice(0, SHOWN_COLUMNS)

  return (
    <Drawer isOpen={!!entry} onClose={onClose} panelClassName="max-w-4xl">
      <DrawerHeader icon={<Rows className="h-5 w-5 text-gray-700" />} title={entry ? titleOf(entry) : ''}
        onClose={onClose}
        description="The rows as they were deleted. Restore the ones you pick, or the whole batch from the list." />
      <DrawerBody>
        <div className="flex flex-wrap items-center gap-2">
          <select className="input w-auto py-1 text-sm" value={column} onChange={e => setColumn(e.target.value)}
            aria-label="Column to search" data-testid="trash-rows-column">
            <option value="">Any column</option>
            {columns.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <div className="relative flex-1 min-w-[12rem]">
            <Search className="h-3.5 w-3.5 absolute left-2 top-2.5 text-gray-400" />
            <input className="input pl-7 py-1 text-sm" placeholder="Find rows holding…" value={text}
              onChange={e => setText(e.target.value)} data-testid="trash-rows-search" />
          </div>
          {entry && (
            <button type="button" className="btn-secondary flex items-center gap-1" onClick={() => onDownload(entry)}>
              <Download className="h-3 w-3" /><span>Download CSV</span>
            </button>
          )}
          <button type="button" className="btn-primary flex items-center gap-1 disabled:opacity-50"
            disabled={picked.size === 0 || restoring} onClick={() => void restorePicked()}
            data-testid="trash-rows-restore">
            {restoring ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArchiveRestore className="h-3 w-3" />}
            <span>Restore {picked.size > 0 ? plural(picked.size, 'row') : 'picked rows'}</span>
          </button>
        </div>

        <div className="overflow-x-auto border border-gray-200">
          <table className="min-w-full text-xs" data-testid="trash-rows">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-2 py-1.5 w-6" />
                {shown.map(c => <th key={c} className="px-2 py-1.5 text-left font-medium text-gray-700">{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.seq} className="border-t border-gray-100">
                  <td className="px-2 py-1">
                    <input type="checkbox" checked={picked.has(r.seq)} onChange={() => toggle(r.seq)}
                      aria-label="Pick this row" />
                  </td>
                  {shown.map(c => (
                    <td key={c} className="px-2 py-1 max-w-[14rem] truncate text-gray-800" title={r.cells[c] ?? ''}>
                      {r.cells[c] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && rows.length === 0 && (
          <p className="text-sm text-gray-600">{text ? 'No rows found so far.' : 'No rows.'}</p>
        )}
        {columns.length > SHOWN_COLUMNS && (
          <p className="text-xs text-gray-500">
            Showing the first {SHOWN_COLUMNS} of {columns.length} columns; the CSV has them all.
          </p>
        )}
        {(next !== null || loading) && (
          <button type="button" className="btn-secondary flex items-center gap-1" disabled={loading}
            onClick={() => void load(next ?? undefined)} data-testid="trash-rows-more">
            {loading && <Loader2 className="h-3 w-3 animate-spin" />}
            <span>{text ? 'Search further' : 'Load more'}</span>
          </button>
        )}
      </DrawerBody>
    </Drawer>
  )
}
