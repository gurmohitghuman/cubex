import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Bookmark, Upload } from 'lucide-react'
import toast from 'react-hot-toast'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { setupsAPI, type SetupSummary } from '@/utils/api/setups'
import { TabLoading, TabLoadFailed } from './TabLoading'
import { SetupCard } from './SetupCard'
import { SetupEditModal } from './SetupEditModal'

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback

// Settings → Setups: the saved setups (save one from a sheet's Setups menu or
// a filled column's menu), to rename, describe, export as a file, import one
// from another Cubex, or delete. A setup is a copy: deleting one leaves the
// sheets it was used on as they are.
export const SettingsSetupsTab: React.FC = () => {
  const [setups, setSetups] = useState<SetupSummary[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [editing, setEditing] = useState<SetupSummary | null>(null)
  const [deleting, setDeleting] = useState<SetupSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setFailed(false)
    try { setSetups(await setupsAPI.list()) } catch { setFailed(true) }
  }, [])
  useEffect(() => { void load() }, [load])

  const exportOne = async (s: SetupSummary) => {
    try {
      const { file, filename } = await setupsAPI.exportFile(s.id)
      const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast.error(errorOf(e, "Couldn't export the setup."))
    }
  }

  const importFile = async (f: File | undefined) => {
    if (!f) return
    try {
      let parsed: unknown
      try { parsed = JSON.parse(await f.text()) } catch { throw new Error("This file isn't a Cubex setup file.") }
      const saved = await setupsAPI.importFile(parsed)
      toast.success(`Imported the setup "${saved.name}".`)
      await load()
    } catch (e: any) {
      toast.error(errorOf(e, e?.message || "Couldn't import the setup."))
    } finally {
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const remove = async () => {
    if (!deleting) return
    setBusy(true)
    try {
      await setupsAPI.remove(deleting.id)
      setDeleting(null)
      await load()
    } catch (e) {
      toast.error(errorOf(e, "Couldn't delete the setup."))
    } finally {
      setBusy(false)
    }
  }

  if (failed) return <TabLoadFailed what="your setups" onRetry={() => void load()} />
  if (!setups) return <TabLoading />

  return (
    <div className="card" data-testid="settings-setups">
      <div className="p-6 border-b border-gray-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center space-x-3">
          <div className="bg-gray-100 p-2 rounded-sm"><Bookmark className="h-5 w-5 text-cube-black" /></div>
          <div>
            <h3 className="text-title text-gray-900">Setups</h3>
            <p className="text-sm text-gray-600">
              Saved chains of filled columns. Save one from a sheet&apos;s Setups menu, then build the same columns
              on another sheet.
            </p>
          </div>
        </div>
        <button onClick={() => fileInput.current?.click()} data-testid="setup-import"
          className="btn-secondary flex items-center space-x-2 text-sm px-4 py-2 shrink-0 whitespace-nowrap">
          <Upload className="h-4 w-4" /><span>Import a setup</span>
        </button>
        <input ref={fileInput} type="file" accept=".json,application/json" className="hidden"
          data-testid="setup-import-file" onChange={e => void importFile(e.target.files?.[0])} />
      </div>
      <div className="p-6">
        {setups.length === 0 ? (
          <div className="text-center py-8">
            <Bookmark className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <h4 className="text-lg font-medium text-gray-900 mb-2">No setups yet</h4>
            <p className="text-gray-500 max-w-md mx-auto">
              Open a sheet with AI, enrichment, HTTP API, clean data or formula columns, and choose Setups, then
              Save columns as a setup. Or import a setup file from another Cubex.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {setups.map(s => (
              <SetupCard key={s.id} setup={s} onEdit={() => setEditing(s)} onExport={() => void exportOne(s)}
                onDelete={() => setDeleting(s)} />
            ))}
          </div>
        )}
      </div>
      <SetupEditModal setup={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); void load() }} />
      <ConfirmDialog
        isOpen={!!deleting}
        title="Delete this setup?"
        message={`"${deleting?.name ?? ''}" will be deleted for good. Sheets you used it on keep their columns and `
          + 'values.'}
        confirmText="Delete setup"
        isDestructive
        isLoading={busy}
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  )
}
