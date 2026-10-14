import React, { useState } from 'react'
import toast from 'react-hot-toast'
import { Brush, Plus } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { CleanColumnForm } from '@/components/clean/CleanColumnForm'
import type { CleanOpenTarget } from '@/components/clean/useCleanForm'
import type { CleanColumnView, CleanStartResult } from '@/utils/api'

// Clean data in the dialog: the sheet, its columns and clean columns, what the
// column menu opened it on (null: the dialog's own choice), and what happens
// once cleaning starts.
export interface NewColumnCleanProps {
  sheetId: string
  columns: string[]
  cleanColumns: Record<string, CleanColumnView>
  request: CleanOpenTarget | null
  onStarted: (result: CleanStartResult) => void
}

interface NewColumnModalProps {
  isOpen: boolean
  onClose: () => void
  // Resolves false when the column wasn't added; the dialog then stays open.
  onSubmit: (name: string) => Promise<boolean>
  // Absent: only an empty column is offered.
  clean?: NewColumnCleanProps
}

type Choice = 'empty' | 'clean'
const CHOICES = [
  { id: 'empty', label: 'Empty column', hint: 'Type or paste the values yourself.', Icon: Plus },
  {
    id: 'clean', label: 'Clean data', hint: 'A tidy copy of a column: names, emails, phones and more. Free.',
    Icon: Brush,
  },
] as const

// "+ Add Column": an empty column, or Clean data. The column menu opens it on
// Clean data with a source picked, or on a clean column's setup (Edit
// cleaning). The body mounts afresh on each open, so every open starts clean.
export const NewColumnModal: React.FC<NewColumnModalProps> = ({ isOpen, onClose, onSubmit, clean }) => (
  <Modal isOpen={isOpen} onClose={onClose} panelClassName="max-w-xl">
    <NewColumnBody onClose={onClose} onSubmit={onSubmit} clean={clean} />
  </Modal>
)

const NewColumnBody: React.FC<Omit<NewColumnModalProps, 'isOpen'>> = ({ onClose, onSubmit, clean }) => {
  // Read once: what the dialog opened on (a reload while it's open doesn't change it).
  const [request] = useState(clean?.request ?? null)
  const [editing] = useState(() => (request?.mode === 'edit' ? clean?.cleanColumns[request.column] ?? null : null))
  const [choice, setChoice] = useState<Choice>(request && clean ? 'clean' : 'empty')
  return (
    <>
      <div className="p-6 border-b border-gray-200">
        <h3 className="text-title text-gray-900">{editing ? 'Edit cleaning' : 'Add Column'}</h3>
        <p className="text-sm text-gray-600 mt-1">
          {editing ? `"${editing.column}" is cleaned from "${editing.source}". Saving cleans every row again.`
            : 'Create a new column in this sheet'}
        </p>
      </div>
      <div className="p-6 space-y-4">
        {clean && !editing && (
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="New column">
            {CHOICES.map(c => (
              <button key={c.id} type="button" role="radio" aria-checked={choice === c.id}
                onClick={() => setChoice(c.id)} data-testid={`new-column-${c.id}`}
                className={`text-left border px-3 py-2 transition-colors ${
                  choice === c.id ? 'border-cube-black bg-gray-50' : 'border-gray-200 hover:border-gray-400'}`}>
                <span className="flex items-center gap-1.5 text-sm text-gray-900">
                  <c.Icon className="h-3.5 w-3.5" />{c.label}
                </span>
                <span className="block text-xs text-gray-500 mt-0.5">{c.hint}</span>
              </button>
            ))}
          </div>
        )}
        {clean && choice === 'clean' ? (
          <CleanColumnForm sheetId={clean.sheetId} columns={clean.columns} editing={editing}
            initialSource={request?.mode === 'create' ? request.source : undefined}
            onCancel={onClose} onStarted={clean.onStarted} />
        ) : (
          <EmptyColumnForm onClose={onClose} onSubmit={onSubmit} />
        )}
      </div>
    </>
  )
}

// Today's plain column: a name, then type into it.
const EmptyColumnForm: React.FC<Pick<NewColumnModalProps, 'onClose' | 'onSubmit'>> = ({ onClose, onSubmit }) => {
  const [newColumnName, setNewColumnName] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

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
    <>
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Column name</label>
        <input
          value={newColumnName}
          onChange={(e) => setNewColumnName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
              e.preventDefault()
              handleSubmit()
            }
          }}
          placeholder="e.g. Notes"
          className="input w-full"
          autoFocus
        />
      </div>
      <div className="flex justify-end space-x-3">
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button
          className="btn-primary"
          disabled={isSubmitting}
          onClick={handleSubmit}
        >
          {isSubmitting ? 'Adding…' : 'Add Column'}
        </button>
      </div>
    </>
  )
}
