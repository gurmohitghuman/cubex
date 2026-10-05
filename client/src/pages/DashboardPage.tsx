import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { Table, tablesAPI, settingsAPI } from '@/utils/api'
import toast from 'react-hot-toast'
import { LogOut, Plus, Settings } from 'lucide-react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { FullPageLoader } from '@/components/LoadingSpinner'
import { CubeLogo } from '@/components/CubeLogo'
import { TablesTable } from '@/components/dashboard/TablesTable'
import { CreateTableModal } from '@/components/dashboard/CreateTableModal'
import { RenameTableModal } from '@/components/dashboard/RenameTableModal'
import { GetStartedChecklist } from '@/components/dashboard/GetStartedChecklist'
import { plural } from '@/lib/utils'

export const DashboardPage: React.FC = () => {
  const { logout } = useAuth()
  const [tables, setTables] = useState<Table[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [renameTarget, setRenameTarget] = useState<Table | null>(null)
  // OpenRouter-key status for the get-started checklist. Fetched ONCE here (the
  // dashboard owns it) rather than adding a second settingsAPI.get() —
  // undefined while loading so the checklist doesn't flash a wrong step-state.
  const [hasKey, setHasKey] = useState<boolean | undefined>(undefined)

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
      await tablesAPI.delete(deleteConfirm.id)
      setTables(prev => prev.filter(t => t.id !== deleteConfirm.id))
      toast.success(`Table "${deleteConfirm.name}" deleted`)
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

  if (isLoading) return <FullPageLoader message="Loading your tables…" />

  return (
    <div className="h-screen bg-white flex flex-col overflow-auto">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="flex justify-between items-center h-14">
            <div className="flex items-center space-x-3">
              <CubeLogo size="md" />
              <h1 className="text-lg font-brand-semibold text-gray-900">Cubex</h1>
            </div>
            <div className="flex items-center space-x-2">
              <div className="hidden sm:flex items-center space-x-1 px-2 py-1 bg-gray-50 rounded text-xs text-gray-600">
                <span className="font-medium">{tables.length}</span>
                <span>table{tables.length !== 1 ? 's' : ''}</span>
              </div>
              <Link to="/settings" className="p-2.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors block" title="Settings">
                <Settings className="h-4 w-4" />
              </Link>
              <button onClick={logout}
                className="p-2.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
                title="Sign out">
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 lg:px-8 py-6">
        {/* Front-load the OpenRouter-key requirement. Gated on hasKey being
            known so it can't flash an incorrect step-state during the fetch;
            the component itself auto-hides once table+key are both present. */}
        {hasKey !== undefined && (
          <GetStartedChecklist hasTables={tables.length > 0} hasKey={hasKey} />
        )}

        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center mb-6 space-y-3 sm:space-y-0">
          <div>
            <h2 className="text-display text-gray-900 mb-1">Tables</h2>
            <p className="text-gray-500 text-sm">Manage your data with AI-powered features</p>
            {tables.length > 0 && (
              <div className="flex items-center mt-2 space-x-3 meta-label">
                <span>{tables.length} table{tables.length !== 1 ? 's' : ''}</span>
                <span>•</span>
                <span>{plural(tables.reduce((sum, table) => sum + (table.row_count || 0), 0), 'row')}</span>
              </div>
            )}
          </div>
          <button onClick={() => setShowCreateModal(true)} className="btn-primary flex items-center space-x-2 text-sm px-4 py-2">
            <Plus className="h-4 w-4" />
            <span>New Table</span>
          </button>
        </div>

        {tables.length === 0 ? (
          <div className="iso-grid bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="relative z-10 text-center py-12 px-6">
              <CubeLogo size="lg" className="mx-auto mb-3" />
              <div className="w-12 h-0.5 bg-cube-black rounded-full mx-auto mb-4"></div>
              <h3 className="text-title text-gray-900 mb-2">No tables yet</h3>
              <p className="text-gray-500 mb-6 max-w-md mx-auto text-sm">
                Create your first table to start managing data with AI-powered features.
              </p>
              <button onClick={() => setShowCreateModal(true)} className="btn-primary flex items-center space-x-2 mx-auto text-sm px-4 py-2">
                <Plus className="h-4 w-4" />
                <span>Create Table</span>
              </button>
            </div>
          </div>
        ) : (
          <TablesTable
            tables={tables}
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
        message={`Are you sure you want to delete "${deleteConfirm?.name}"? This action cannot be undone and will delete all associated data.`}
        confirmText="Delete Table"
        onConfirm={handleDeleteTable}
        onCancel={() => setDeleteConfirm(null)}
        isDestructive
        isLoading={isDeleting}
      />
      <RenameTableModal target={renameTarget} onClose={() => setRenameTarget(null)} onRename={handleRenameTable} />
    </div>
  )
}
