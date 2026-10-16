import React, { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import Modal from '@/components/Modal'
import { setupsAPI, type SetupSummary } from '@/utils/api/setups'

const LABEL = 'block text-xs font-medium text-gray-700 mb-1'

// Rename a setup or change what it says it does. Its steps change only by
// saving it again from a sheet.
export const SetupEditModal: React.FC<{ setup: SetupSummary | null; onClose: () => void; onSaved: () => void }> = ({
  setup, onClose, onSaved,
}) => {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (setup) { setName(setup.name); setDescription(setup.description ?? '') }
  }, [setup])

  const save = async () => {
    if (!setup || !name.trim()) return
    setSaving(true)
    try {
      await setupsAPI.update(setup.id, { name: name.trim(), description })
      onSaved()
    } catch (e: any) {
      toast.error(e?.response?.data?.error || "Couldn't save the setup.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen={!!setup} onClose={() => { if (!saving) onClose() }}>
      <div className="p-6 border-b border-gray-200">
        <h3 className="text-title text-gray-900">Edit setup</h3>
      </div>
      <div className="p-6 space-y-4">
        <label className="block">
          <span className={LABEL}>Name</span>
          <input className="input w-full" value={name} onChange={e => setName(e.target.value)} maxLength={100}
            data-testid="setup-edit-name" />
        </label>
        <label className="block">
          <span className={LABEL}>What it does (optional)</span>
          <input className="input w-full" value={description} onChange={e => setDescription(e.target.value)}
            maxLength={1000} />
        </label>
        <p className="text-xs text-gray-500">
          To change its columns, save the setup again from a sheet under a name of its own.
        </p>
      </div>
      <div className="px-6 pb-6 flex justify-end gap-3">
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!name.trim() || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  )
}
