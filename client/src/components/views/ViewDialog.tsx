import React, { useEffect, useState } from 'react'
import Modal from '@/components/Modal'
import type { SheetView } from '@/utils/api'

const LABEL = 'block text-xs font-medium text-gray-700 mb-1'

export type ViewDialogState = { mode: 'new' } | { mode: 'edit' | 'delete'; view: SheetView } | null

interface Props {
  state: ViewDialogState
  onClose: () => void
  onCreate: (name: string, description: string) => Promise<boolean>
  onSave: (viewId: string, name: string, description: string) => Promise<boolean>
  onDelete: (viewId: string) => Promise<boolean>
}

// New view (a copy of the one showing), rename and describe a view, or delete
// one. A view only saves what the sheet shows: rows and columns never change.
export const ViewDialog: React.FC<Props> = ({ state, onClose, onCreate, onSave, onDelete }) => {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!state) return
    setName(state.mode === 'new' ? '' : state.view.name)
    setDescription(state.mode === 'new' ? '' : state.view.description ?? '')
    setSaving(false)
  }, [state])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!state || saving) return
    setSaving(true)
    const done = state.mode === 'new' ? await onCreate(name, description)
      : state.mode === 'edit' ? await onSave(state.view.id, name, description)
      : await onDelete(state.view.id)
    setSaving(false)
    if (done) onClose()
  }

  const title = state?.mode === 'new' ? 'New view' : state?.mode === 'edit' ? 'Rename view' : 'Delete view'
  return (
    <Modal isOpen={!!state} onClose={() => { if (!saving) onClose() }} panelClassName="max-w-md w-full">
      <form onSubmit={submit} data-testid="view-dialog">
        <div className="p-6 border-b border-gray-200">
          <h3 className="text-title text-gray-900">{title}</h3>
          <p className="text-sm text-gray-600 mt-1">
            {state?.mode === 'new'
              ? 'Starts as a copy of the view showing now: its filters and hidden columns. Changes you make '
                + 'after that are saved to the new view.'
              : state?.mode === 'delete'
                ? `Delete "${state.view.name}"? Only the view goes: no rows or columns change.`
                : 'A view keeps its own filters and hidden columns. Rows and columns are shared by every view.'}
          </p>
        </div>
        {state?.mode !== 'delete' && (
          <div className="p-6 space-y-4">
            <label className="block">
              <span className={LABEL}>Name</span>
              <input className="input w-full" value={name} onChange={e => setName(e.target.value)} maxLength={100}
                placeholder="Qualified leads" autoFocus data-testid="view-name" />
            </label>
            <label className="block">
              <span className={LABEL}>Description (optional)</span>
              <input className="input w-full" value={description} maxLength={1000}
                onChange={e => setDescription(e.target.value)} placeholder="Rows ready to send" />
            </label>
          </div>
        )}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving || (state?.mode !== 'delete' && !name.trim())}
            data-testid="view-dialog-submit">
            {state?.mode === 'new' ? 'Add view' : state?.mode === 'edit' ? 'Save' : 'Delete view'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
