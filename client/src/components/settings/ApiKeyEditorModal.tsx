import React, { useEffect, useState } from 'react'
import { Eye, EyeOff, Loader2, Shield } from 'lucide-react'
import { APIKey } from '@/utils/api'

interface Form {
  name: string
  key_type: 'bearer' | 'api_key' | 'custom'
  key_value: string
  description: string
}

const blankForm: Form = { name: '', key_type: 'bearer', key_value: '', description: '' }

interface Props {
  isOpen: boolean
  editing: APIKey | null
  onCancel: () => void
  onCreate: (form: Form) => Promise<void>
  onUpdate: (id: string, form: Form) => Promise<void>
}

export const ApiKeyEditorModal: React.FC<Props> = ({ isOpen, editing, onCancel, onCreate, onUpdate }) => {
  const [form, setForm] = useState<Form>(blankForm)
  const [showValue, setShowValue] = useState(false)
  const [busy, setBusy] = useState(false)

  // When opening for edit, seed form fields (but never the key value — we don't
  // round-trip plaintext keys to the client).
  useEffect(() => {
    if (editing) {
      setForm({ name: editing.name, key_type: editing.key_type, key_value: '', description: editing.description || '' })
    } else if (isOpen) {
      setForm(blankForm)
    }
    setShowValue(false)
  }, [editing, isOpen])

  if (!isOpen) return null

  const canSubmit = !!form.name.trim() && !!form.key_value.trim()
  const handleSubmit = async () => {
    if (!canSubmit) return
    setBusy(true)
    try {
      if (editing) await onUpdate(editing.id, form)
      else await onCreate(form)
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 bg-cube-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center space-x-3">
            <div className="bg-gray-100 p-2 rounded-lg"><Shield className="h-5 w-5 text-gray-700" /></div>
            <div>
              <h3 className="text-title text-gray-900">{editing ? 'Edit API Key' : 'Create API Key'}</h3>
              <p className="text-sm text-gray-600">{editing ? 'Update the API key details' : 'Add a new API key for HTTP requests'}</p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Name *</label>
            <input
              type="text"
              className="input w-full"
              placeholder="e.g., openai_key, stripe_secret"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <p className="text-xs text-gray-500 mt-1">
              Use this name to reference the key: /{form.name || 'key_name'}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Key Type *</label>
            <select className="input w-full" value={form.key_type} onChange={(e) => setForm({ ...form, key_type: e.target.value as Form['key_type'] })}>
              <option value="bearer">Bearer Token</option>
              <option value="api_key">API Key</option>
              <option value="custom">Custom</option>
            </select>
            <p className="text-xs text-gray-500 mt-1">
              {form.key_type === 'bearer' && 'For Authorization: Bearer headers'}
              {form.key_type === 'api_key' && 'For X-API-Key or similar headers'}
              {form.key_type === 'custom' && 'For custom header names'}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Key Value *</label>
            <div className="relative">
              <input
                type={showValue ? 'text' : 'password'}
                className="input w-full pr-20"
                placeholder="Enter your API key"
                value={form.key_value}
                onChange={(e) => setForm({ ...form, key_value: e.target.value })}
              />
              <button type="button" onClick={() => setShowValue(!showValue)} className="absolute right-12 top-2.5 text-gray-400 hover:text-gray-600">
                {showValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">Your API key is stored securely and encrypted</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
            <input
              type="text"
              className="input w-full"
              placeholder="Optional description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
        </div>

        <div className="flex space-x-3 p-6 border-t border-gray-200">
          <button onClick={onCancel} className="btn-secondary flex-1">Cancel</button>
          <button onClick={handleSubmit} disabled={busy || !canSubmit} className="btn-primary flex-1 disabled:opacity-50">
            {busy ? (
              <div className="flex items-center justify-center space-x-2">
                <Loader2 className="h-4 w-4 animate-spin text-white" />
                <span>{editing ? 'Updating…' : 'Creating…'}</span>
              </div>
            ) : (editing ? 'Update Key' : 'Create Key')}
          </button>
        </div>
      </div>
    </div>
  )
}
