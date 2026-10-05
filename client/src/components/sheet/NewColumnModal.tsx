import React, { useState } from 'react'
import toast from 'react-hot-toast'
import { Modal } from '@/components/Modal'

interface NewColumnModalProps {
  isOpen: boolean
  onClose: () => void
  // Resolves false when the column wasn't added; the dialog then stays open.
  onSubmit: (name: string) => Promise<boolean>
}

export const NewColumnModal: React.FC<NewColumnModalProps> = ({ isOpen, onClose, onSubmit }) => {
  const [newColumnName, setNewColumnName] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleClose = () => {
    setNewColumnName('')
    onClose()
  }

  const handleSubmit = async () => {
    if (isSubmitting) return
    const name = newColumnName.trim()
    if (!name) {
      toast.error('Column name is required')
      return
    }
    setIsSubmitting(true)
    try {
      if (!(await onSubmit(name))) return
      setNewColumnName('')
      onClose()
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} panelClassName="max-w-md">
      <div className="p-6 border-b border-gray-200">
        <h3 className="text-title text-gray-900">Add Column</h3>
        <p className="text-sm text-gray-600 mt-1">Create a new column in this sheet</p>
      </div>
      <div className="p-6 space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Column name</label>
          <input
            value={newColumnName}
            onChange={(e) => setNewColumnName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); handleSubmit() } }}
            placeholder="e.g. Notes"
            className="input w-full"
            autoFocus
          />
        </div>
        <div className="flex justify-end space-x-3">
          <button className="btn-secondary" onClick={handleClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={isSubmitting}
            onClick={handleSubmit}
          >
            {isSubmitting ? 'Adding…' : 'Add Column'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
