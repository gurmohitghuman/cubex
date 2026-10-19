import React, { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { ArchiveRestore, ArrowLeft, Loader2, Search, Trash2, X } from 'lucide-react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { TrashList } from '@/components/trash/TrashList'
import { TrashRowsDrawer } from '@/components/trash/TrashRowsDrawer'
import { useTrash } from '@/components/trash/useTrash'
import { howText, restoredText, sizeText, titleOf } from '@/components/trash/trash-copy'
import { plural } from '@/lib/utils'
import { trashAPI, type TrashEntry, type TrashHow, type TrashKind } from '@/utils/api'

const KINDS: Array<{ id: TrashKind | ''; label: string }> = [
  { id: '', label: 'All' }, { id: 'table', label: 'Tables' }, { id: 'sheet', label: 'Sheets' },
  { id: 'rows', label: 'Rows' },
]

// The account's trash: deleted tables, sheets and batches of rows, kept for
// the days Settings sets, then deleted for good. Search, restore (one or
// several), look inside a batch, download it, or delete it for good now.
export const TrashPage: React.FC = () => {
  const navigate = useNavigate()
  // A link can narrow it to one sheet and how its rows went (?sheet=…&how=auto_dedupe).
  const [params, setParams] = useSearchParams()
  const scope = {
    sheetId: params.get('sheet') ?? undefined, how: (params.get('how') ?? undefined) as TrashHow | undefined,
  }
  const t = useTrash(scope)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState<Set<number>>(new Set())
  const [looking, setLooking] = useState<TrashEntry | null>(null)
  const [deleting, setDeleting] = useState<TrashEntry[] | null>(null)

  const toggle = (id: number) => setSelected(prev => {
    const s = new Set(prev)
    if (s.has(id)) s.delete(id); else s.add(id)
    return s
  })
  const restore = async (entries: TrashEntry[]) => {
    const ids = entries.map(e => e.id)
    setBusy(new Set(ids))
    try {
      const { results } = await trashAPI.restore(ids)
      for (const r of results) {
        const e = entries.find(x => x.id === r.trash_id)
        if (!r.restored) { toast.error(`${e ? `${titleOf(e)}: ` : ''}${r.error ?? "Couldn't restore it"}`); continue }
        const open = r.restored.table_id
          ? `/table/${r.restored.table_id}${r.restored.sheet_id ? `/${r.restored.sheet_id}` : ''}`
          : e ? `/table/${e.table_id}${e.sheet_id ? `/${e.sheet_id}` : ''}` : null
        toast.success(tt => (
          <span className="flex items-start gap-3">
            <span>{restoredText(r, e)}</span>
            {open && (
              <button type="button" className="underline whitespace-nowrap"
                onClick={() => { toast.dismiss(tt.id); navigate(open) }}>Open</button>
            )}
          </span>
        ), { duration: 8000 })
      }
      setSelected(new Set())
      t.reload()
    } catch (err: any) {
      toast.error(err?.response?.data?.error || "Couldn't restore")
    } finally { setBusy(new Set()) }
  }
  const deleteForGood = async () => {
    if (!deleting) return
    try {
      await trashAPI.deleteForGood(deleting.map(e => e.id))
      toast.success(deleting.length === 1 ? 'Deleting…' : `Deleting ${deleting.length} items…`)
      setSelected(new Set())
      t.reload()
    } catch (err: any) {
      toast.error(err?.response?.data?.error || "Couldn't delete")
    } finally { setDeleting(null) }
  }
  const download = async (e: TrashEntry) => {
    try {
      const blob = await trashAPI.csv(e.id)
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${e.sheet_name ?? 'Sheet'} - deleted rows.csv`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)
    } catch {
      toast.error("Couldn't download the rows")
    }
  }
  const chosen = t.items.filter(i => selected.has(i.id))

  return (
    <div className="h-screen bg-white overflow-auto">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="flex items-center space-x-4">
          <button onClick={() => navigate('/dashboard')} className="p-2 text-gray-400 hover:text-gray-600"
            aria-label="Back">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h1 className="text-title text-gray-900">Trash</h1>
            <p className="text-gray-600 text-sm">
              {t.days === null ? 'Deleted tables, sheets and rows.'
                : t.days === 0 ? 'Deleted tables, sheets and rows aren\'t kept here.'
                : `Deleted tables, sheets and rows stay here ${plural(t.days, 'day')}, then are deleted.`}
              {' '}<Link to="/settings/account" className="underline">Change it in Settings</Link>.
              {t.totalBytes > 0 && ` Deleted rows use ${sizeText(t.totalBytes)}.`}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[14rem]">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-2.5 text-gray-400" />
            <input className="input pl-8" placeholder="Search by table, sheet or access token" value={t.q}
              onChange={e => t.setQ(e.target.value)} data-testid="trash-search" />
          </div>
          {(scope.sheetId || scope.how) && (
            <button type="button" onClick={() => setParams({})} data-testid="trash-scope"
              className="flex items-center gap-1 px-2 py-1.5 text-sm bg-gray-100 text-gray-700 hover:bg-gray-200">
              <span>
                {scope.how ? howText(scope.how) : 'Deleted'}
                {scope.sheetId && t.items[0]?.sheet_name ? ` from "${t.items[0].sheet_name}"` : ''}
              </span>
              <X className="h-3.5 w-3.5" aria-label="Show everything" />
            </button>
          )}
          <div className="flex border border-gray-300" role="group" aria-label="Show">
            {KINDS.map(k => (
              <button key={k.id} type="button" onClick={() => t.setKind(k.id)} aria-pressed={t.kind === k.id}
                className={`px-3 py-1.5 text-sm ${t.kind === k.id
                  ? 'bg-cube-black text-white' : 'bg-white text-gray-700'}`}>
                {k.label}
              </button>
            ))}
          </div>
        </div>

        {chosen.length > 0 && (
          <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 px-3 py-2" data-testid="trash-bulk">
            <span className="text-sm text-gray-700 mr-auto">{chosen.length} selected</span>
            <button type="button" className="btn-primary flex items-center gap-1" onClick={() => void restore(chosen)}
              data-testid="trash-bulk-restore">
              <ArchiveRestore className="h-3 w-3" /><span>Restore</span>
            </button>
            <button type="button" className="btn-danger flex items-center gap-1" onClick={() => setDeleting(chosen)}>
              <Trash2 className="h-3 w-3" /><span>Delete</span>
            </button>
          </div>
        )}

        {t.error ? <p className="text-sm text-red-600">{t.error}</p>
          : t.items.length === 0 ? (
            t.loading ? <p className="text-sm text-gray-600 flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
              : <p className="text-sm text-gray-600" data-testid="trash-empty">
                {t.q || t.kind || scope.sheetId || scope.how ? 'Nothing in the trash matches.'
                  : 'The trash is empty.'}</p>
          ) : (
            <TrashList items={t.items} selected={selected} onToggle={toggle} busy={busy}
              onRestore={e => void restore([e])} onLook={setLooking} onDownload={e => void download(e)}
              onDelete={e => setDeleting([e])} />
          )}
        {t.hasMore && (
          <button type="button" className="btn-secondary" onClick={() => void t.loadMore()}>Load more</button>
        )}
      </div>

      <TrashRowsDrawer entry={looking} onClose={() => setLooking(null)} onRestored={t.reload}
        onDownload={e => void download(e)} />
      <ConfirmDialog isOpen={!!deleting} isDestructive title="Delete"
        message={deleting?.length === 1
          ? `Delete ${titleOf(deleting[0])}? It can't be restored after this.`
          : `Delete ${deleting?.length ?? 0} items? They can't be restored after this.`}
        confirmText="Delete" onConfirm={() => void deleteForGood()} onCancel={() => setDeleting(null)} />
    </div>
  )
}
