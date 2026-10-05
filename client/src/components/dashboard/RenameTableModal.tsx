import React, { useState, useEffect } from 'react'
import { Edit3 } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { Table } from '@/utils/api'

interface RenameTableModalProps {
  target: Table | null
  onClose: () => void
  onRename: (id: string, name: string) => Promise<void>
}

export const RenameTableModal: React.FC<RenameTableModalProps> = ({ target, onClose, onRename }) => {
  const [name, setName] = useState('')
  const [isRenaming, setIsRenaming] = useState(false)

  useEffect(() => {
    if (target) setName(target.name)
  }, [target])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!target || !name.trim() || isRenaming) return
    setIsRenaming(true)
    try {
      await onRename(target.id, name.trim())
      onClose()
    } finally {
      setIsRenaming(false)
    }
  }

  return (
    <Modal isOpen={!!target} onClose={onClose} panelClassName="max-w-sm w-full">
      <div className="p-6 border-b border-gray-200">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-cube-black flex items-center justify-center">
            <Edit3 className="h-5 w-5 text-white" />
          </div>
          <div>
            <h3 className="text-title text-gray-900">Rename Table</h3>
            <p className="text-xs text-gray-500">Update the table name</p>
          </div>
        </div>
      </div>
      <form onSubmit={handleSubmit} className="p-6">
        <div className="mb-4">
          <label htmlFor="renameName" className="block text-sm font-medium text-gray-900 mb-2">New Name</label>
          <input
            id="renameName"
            type="text"
            className="input w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        <div className="flex space-x-3">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button type="submit" disabled={isRenaming || !name.trim()} className="btn-primary flex-1 disabled:opacity-50">
            {isRenaming ? 'Renaming…' : 'Rename'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
