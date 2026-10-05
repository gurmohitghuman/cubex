import React, { useState } from 'react'
import { Edit3, Key, Loader2, Plus, Shield, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { APIKey, settingsAPI } from '@/utils/api'
import { ApiKeyEditorModal } from './ApiKeyEditorModal'

interface ApiKeysSectionProps {
  apiKeys: APIKey[]
  reloadAPIKeys: () => Promise<void>
}

export const ApiKeysSection: React.FC<ApiKeysSectionProps> = ({ apiKeys, reloadAPIKeys }) => {
  const [editing, setEditing] = useState<APIKey | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const handleCreate = async (form: { name: string; key_type: 'bearer' | 'api_key' | 'custom'; key_value: string; description: string }) => {
    try {
      await settingsAPI.createAPIKey(form)
      await reloadAPIKeys()
      setShowCreate(false)
      toast.success('API key created successfully')
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to create API key')
    }
  }

  const handleUpdate = async (id: string, form: { name: string; key_type: 'bearer' | 'api_key' | 'custom'; key_value: string; description: string }) => {
    try {
      await settingsAPI.updateAPIKey(id, form)
      await reloadAPIKeys()
      setEditing(null)
      // No success toast — the updated values are visible in the list row.
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to update API key')
    }
  }

  const handleDelete = async (id: string) => {
    setDeletingId(id)
    try {
      await settingsAPI.deleteAPIKey(id)
      await reloadAPIKeys()
      // No success toast — the row disappears from the list immediately.
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to delete API key')
    } finally { setDeletingId(null) }
  }

  return (
    <>
      <div className="card mb-6">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="bg-gray-100 p-2 rounded-sm"><Shield className="h-5 w-5 text-cube-black" /></div>
              <div>
                <h3 className="text-title text-gray-900">External service keys</h3>
                <p className="text-sm text-gray-600">
                  Saved credentials for external APIs used by HTTP enrichment. Reference them as /key_name
                </p>
              </div>
            </div>
            <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center space-x-2 text-sm px-4 py-2 shrink-0 whitespace-nowrap">
              <Plus className="h-4 w-4" /><span>Add key</span>
            </button>
          </div>
        </div>

        <div className="p-6">
          {apiKeys.length === 0 ? (
            <div className="text-center py-8">
              <Shield className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <h4 className="text-lg font-medium text-gray-900 mb-2">No saved keys yet</h4>
              <p className="text-gray-500 mb-4">
                Save a key for an external service (Apollo, Hunter, …) and reference it in
                HTTP enrichment requests as /key_name
              </p>
              <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center space-x-2 mx-auto">
                <Plus className="h-4 w-4" /><span>Add first key</span>
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {apiKeys.map((apiKey) => (
                <div key={apiKey.id} className="flex items-center justify-between p-4 border border-gray-200 rounded-lg">
                  <div className="flex items-center space-x-3">
                    <div className="bg-gray-100 p-2 rounded-sm"><Key className="h-4 w-4 text-gray-600" /></div>
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="font-medium text-gray-900">{apiKey.name}</span>
                        <span className={`px-2 py-1 text-xs ${
                          apiKey.key_type === 'bearer' ? 'bg-cube-black text-white' :
                          apiKey.key_type === 'api_key' ? 'bg-white text-cube-black border border-cube-black' :
                          'bg-gray-100 text-cube-black'
                        }`}>{apiKey.key_type}</span>
                      </div>
                      {apiKey.description && <p className="text-sm text-gray-500">{apiKey.description}</p>}
                      <p className="text-xs text-gray-400">
                        Reference: <code className="bg-gray-100 px-1 rounded">/{apiKey.name}</code>
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <button onClick={() => setEditing(apiKey)} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors" title="Edit API key">
                      <Edit3 className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(apiKey.id)}
                      disabled={deletingId === apiKey.id}
                      className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors disabled:opacity-50"
                      title="Delete API key"
                    >
                      {deletingId === apiKey.id ? (
                        <Loader2 className="h-4 w-4 animate-spin text-cube-black" />
                      ) : <Trash2 className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <ApiKeyEditorModal
        isOpen={showCreate || !!editing}
        editing={editing}
        onCancel={() => { setShowCreate(false); setEditing(null) }}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
      />
    </>
  )
}
