import React, { useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { Modal } from '@/components/Modal'

interface CreateTableModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (name: string) => Promise<void>
}

export const CreateTableModal: React.FC<CreateTableModalProps> = ({ isOpen, onClose, onCreate }) => {
  const [name, setName] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || isCreating) return
    setIsCreating(true)
    try {
      await onCreate(name.trim())
      setName('')
      onClose()
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} panelClassName="max-w-sm w-full">
      <div className="p-6 border-b border-gray-200">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-cube-black flex items-center justify-center">
            <Plus className="h-5 w-5 text-white" />
          </div>
          <div>
            <h3 className="text-title text-gray-900">New Table</h3>
            <p className="text-xs text-gray-500">Create a new data table</p>
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="p-6">
        <div className="mb-4">
          <label htmlFor="tableName" className="block text-sm font-medium text-gray-900 mb-2">Table Name</label>
          <input
            id="tableName"
            type="text"
            className="input w-full"
            placeholder="Enter table name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        <div className="flex space-x-3">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button type="submit" disabled={isCreating || !name.trim()} className="btn-primary flex-1 disabled:opacity-50">
            {isCreating ? (
              <div className="flex items-center justify-center space-x-2">
                <Loader2 className="h-3 w-3 animate-spin text-white" />
                <span>Creating…</span>
              </div>
            ) : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
