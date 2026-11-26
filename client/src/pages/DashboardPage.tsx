import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Table, tablesAPI, settingsAPI } from '@/utils/api'
import toast from 'react-hot-toast'
import { Bot, Plus, Search, Upload, X } from 'lucide-react'
import { toastDeleted } from '@/components/trash/trashToast'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { FullPageLoader } from '@/components/LoadingSpinner'
import { CubeLogo } from '@/components/CubeLogo'
import { AppShell } from '@/components/layout/AppShell'
import { TablesTable } from '@/components/dashboard/TablesTable'
import { CreateTableModal } from '@/components/dashboard/CreateTableModal'
import { NewTableButton } from '@/components/dashboard/NewTableButton'
import { useImportCsvTable } from '@/components/dashboard/useImportCsvTable'
import { useToastsBelowTopBar } from '@/hooks/useToastsBelowTopBar'
import { RenameTableModal } from '@/components/dashboard/RenameTableModal'
import { GetStartedChecklist } from '@/components/dashboard/GetStartedChecklist'
import { TrySampleButton } from '@/components/sample/TrySampleButton'
import { useSampleTable } from '@/components/sample/useSampleTable'
import { AiVisibilityButton } from '@/components/ai-visibility/AiVisibilityDialog'
import { HiringButton } from '@/components/hiring/HiringDialog'
import { SocialButton } from '@/components/social/SocialDialog'
import { plural } from '@/lib/utils'
import { useTableRowCounts } from '@/hooks/useTableRowCounts'
import { useTableRuns } from '@/hooks/useTableRuns'

// The home: the sidebar (components/layout), then "Tables" with a search by name and the New table button, the
// get-started checklist while it has steps left, and the list of tables (or, with none yet, the ways to start).
export const DashboardPage: React.FC = () => {
  useToastsBelowTopBar()
  const [tables, setTables] = useState<Table[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [renameTarget, setRenameTarget] = useState<Table | null>(null)
  // OpenRouter-key status for the get-started checklist. Fetched ONCE here (the
  // dashboard owns it) rather than adding a second settingsAPI.get() —
  // undefined while loading so the checklist doesn't flash a wrong step-state.
  const [hasKey, setHasKey] = useState<boolean | undefined>(undefined)
  const countsPlain = useTableRowCounts(tables, setTables)
  useTableRuns(!isLoading, setTables)
  const fileInput = useRef<HTMLInputElement>(null)
  const { importFile, importing } = useImportCsvTable()
  const { createSample, creatingSample } = useSampleTable()

  useEffect(() => {
    tablesAPI.getAll()
      .then(setTables)
      .catch(err => { toast.error('Failed to load tables'); console.error('Load tables error:', err) })
      .finally(() => setIsLoading(false))
    // Non-blocking: the checklist just doesn't render its key-step state until
    // this resolves. A settings failure shouldn't break the dashboard.
    settingsAPI.get()
      .then(s => setHasKey(!!s.hasOpenRouterKey))
      .catch(() => setHasKey(undefined))
  }, [])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? tables.filter(t => t.name.toLowerCase().includes(q)) : tables
  }, [tables, query])

  const handleCreateTable = async (name: string) => {
    try {
      const table = await tablesAPI.create(name)
      setTables(prev => [table, ...prev])
      // No success toast — the new table appears in the list immediately.
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to create table')
      throw error
    }
  }

  const handleDeleteTable = async () => {
    if (!deleteConfirm) return
    setIsDeleting(true)
    try {
      const { trash } = await tablesAPI.delete(deleteConfirm.id)
      setTables(prev => prev.filter(t => t.id !== deleteConfirm.id))
      toastDeleted(`Table "${deleteConfirm.name}" moved to the trash`, trash?.id, {
        onRestored: () => { tablesAPI.getAll().then(setTables).catch(() => {}) },
      })
      setDeleteConfirm(null)
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to delete table')
    } finally {
      setIsDeleting(false)
    }
  }

  const handleRenameTable = async (id: string, newName: string) => {
    try {
      const updated = await tablesAPI.update(id, newName)
      setTables(prev => prev.map(t => t.id === updated.id ? { ...t, name: updated.name } : t))
      // No success toast — the new name is immediately visible in the list.
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to rename table')
      throw error
    }
  }

  // The sidebar shows at once, the list beside it once it comes.
  if (isLoading) return <AppShell><FullPageLoader message="Loading your tables…" /></AppShell>

  const working = importing ? `Importing ${importing}…` : creatingSample ? 'Making the sample…' : null
  const pickFile = () => fileInput.current?.click()
  return (
    <AppShell>
      {/* The page's bar: toasts show below it (useToastsBelowTopBar). */}
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white">
        <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
          <h1 className="text-lg font-semibold text-gray-900">Tables</h1>
          {tables.length > 0 && (
            <span className="meta-label hidden sm:inline" data-testid="tables-summary">
              {plural(tables.length, 'table')} · {plural(tables.reduce((n, t) => n + (t.row_count || 0), 0), 'row')}
            </span>
          )}
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {tables.length > 0 && (
              <label className="relative flex min-w-0 items-center">
                <span className="sr-only">Search tables</span>
                <Search className="pointer-events-none absolute left-2.5 h-4 w-4 text-gray-400" />
                <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search tables"
                  data-testid="tables-search" className="input h-9 w-32 pl-8 text-sm sm:w-56" />
              </label>
            )}
            <NewTableButton onEmpty={() => setShowCreateModal(true)} onImport={pickFile}
              onSample={() => void createSample()} working={working} />
          </div>
        </div>
      </header>
      <input ref={fileInput} type="file" accept=".csv,text/csv" className="hidden" data-testid="new-table-file"
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f) }} />

      <div className="px-4 py-6 sm:px-6">
        {/* Front-load the OpenRouter-key requirement. Gated on hasKey being
            known so it can't flash an incorrect step-state during the fetch;
            the component itself auto-hides once table+key are both present. */}
        {hasKey !== undefined && (
          <GetStartedChecklist hasTables={tables.length > 0} hasKey={hasKey} />
        )}

        {tables.length === 0 ? (
          <div className="iso-grid overflow-hidden rounded-lg border border-gray-200 bg-white">
            <div className="relative z-10 px-6 py-12 text-center">
              <CubeLogo size="lg" className="mx-auto mb-3" />
              <div className="mx-auto mb-4 h-0.5 w-12 rounded-full bg-cube-black"></div>
              <h2 className="text-title mb-2 text-gray-900">No tables yet</h2>
              <p className="mx-auto mb-6 max-w-md text-sm text-gray-500">
                Start with an empty table, a CSV file, or 25 made-up leads to try Cubex on.
              </p>
              <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
                <button onClick={() => setShowCreateModal(true)}
                  className="btn-primary flex items-center space-x-2 px-4 py-2 text-sm">
                  <Plus className="h-4 w-4" />
                  <span>Create Table</span>
                </button>
                <button type="button" onClick={pickFile} disabled={!!working} data-testid="empty-import"
                  className="btn-secondary flex items-center space-x-2 px-4 py-2 text-sm disabled:opacity-50">
                  <Upload className="h-4 w-4" />
                  <span>Import CSV</span>
                </button>
                <TrySampleButton />
              </div>
              <p className="mb-3 mt-8 text-xs text-gray-500">Or a ready-made table</p>
              <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
                <AiVisibilityButton />
                <HiringButton />
                <SocialButton />
              </div>
              <Link to="/settings/agents" data-testid="connect-agent"
                className="mt-8 inline-flex items-center gap-2 text-sm text-gray-700 underline hover:text-gray-900">
                <Bot className="h-4 w-4" /> Connect your agent
              </Link>
            </div>
          </div>
        ) : shown.length === 0 ? (
          <div className="rounded-lg border border-gray-200 px-6 py-10 text-center text-sm text-gray-500"
            data-testid="tables-no-match">
            No table's name has "{query.trim()}" in it.
            <button type="button" onClick={() => setQuery('')}
              className="ml-2 inline-flex items-center gap-1 text-gray-700 underline hover:text-gray-900">
              <X className="h-3.5 w-3.5" /> Clear the search
            </button>
          </div>
        ) : (
          <TablesTable
            tables={shown}
            countsPlain={countsPlain}
            onRename={(t) => setRenameTarget(t)}
            onDelete={(t) => setDeleteConfirm({ id: t.id, name: t.name })}
          />
        )}
      </div>

      <CreateTableModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreate={handleCreateTable}
      />
      <ConfirmDialog
        isOpen={!!deleteConfirm}
        title="Delete Table"
        message={`Delete "${deleteConfirm?.name}" with all its sheets? It goes to the trash, where you can `
          + "restore it as it was until it's deleted."}
        confirmText="Delete Table"
        onConfirm={handleDeleteTable}
        onCancel={() => setDeleteConfirm(null)}
        isDestructive
        isLoading={isDeleting}
      />
      <RenameTableModal target={renameTarget} onClose={() => setRenameTarget(null)} onRename={handleRenameTable} />
    </AppShell>
  )
}
