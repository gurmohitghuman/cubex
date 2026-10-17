import React, { useState } from 'react'
import toast from 'react-hot-toast'
import { Brush, FunctionSquare, Link2, Plus } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { CleanColumnForm } from '@/components/clean/CleanColumnForm'
import { FormulaColumnForm } from '@/components/formula/FormulaColumnForm'
import { LookupColumnForm } from '@/components/lookup/LookupColumnForm'
import type { CleanOpenTarget } from '@/components/clean/useCleanForm'
import type { FormulaOpenTarget } from '@/components/formula/useFormulaForm'
import type { LookupOpenTarget } from '@/components/lookup/useLookupForm'
import type {
  CleanColumnView, CleanStartResult, FormulaColumnView, FormulaStartResult, LookupColumnView, LookupStartResult,
} from '@/utils/api'

// What the column menu (or a header's auto-run icon) opened the dialog on.
export type NewColumnOpenTarget = CleanOpenTarget | FormulaOpenTarget | LookupOpenTarget

// Clean data, formulas and lookups in the dialog: the sheet, its columns, its
// clean, formula and lookup columns, what the dialog was opened on (null: the
// dialog's own choice), and what happens once one starts filling.
export interface NewColumnSetupProps {
  sheetId: string
  columns: string[]
  cleanColumns: Record<string, CleanColumnView>
  formulaColumns: Record<string, FormulaColumnView>
  lookupColumns: Record<string, LookupColumnView>
  request: NewColumnOpenTarget | null
  onStarted: (result: CleanStartResult) => void
  onFormulaStarted: (result: FormulaStartResult) => void
  onLookupStarted: (result: LookupStartResult) => void
}

interface NewColumnModalProps {
  isOpen: boolean
  onClose: () => void
  // Resolves false when the column wasn't added; the dialog then stays open.
  onSubmit: (name: string) => Promise<boolean>
  // Absent: only an empty column is offered.
  setup?: NewColumnSetupProps
}

type Choice = 'empty' | 'clean' | 'formula' | 'lookup'
const CHOICES = [
  { id: 'empty', label: 'Empty column', hint: 'Type or paste the values yourself.', Icon: Plus },
  {
    id: 'clean', label: 'Clean data', hint: 'A tidy copy of a column: names, emails, phones and more. Free.',
    Icon: Brush,
  },
  {
    id: 'formula', label: 'Formula', hint: 'Worked out from each row, like a field picked from an API reply. Free.',
    Icon: FunctionSquare,
  },
  {
    id: 'lookup', label: 'Lookup', hint: 'Values from another sheet, matched on a column of this row. Free.',
    Icon: Link2,
  },
] as const

const isFormulaTarget = (t: NewColumnOpenTarget | null): t is FormulaOpenTarget =>
  !!t && (t.mode === 'formula-new' || t.mode === 'formula-edit')
const isLookupTarget = (t: NewColumnOpenTarget | null): t is LookupOpenTarget =>
  !!t && (t.mode === 'lookup-new' || t.mode === 'lookup-edit')

// "+ Add Column": an empty column, Clean data, a Formula or a Lookup. The
// column menu opens it on Clean data with a source picked, on a clean column's
// setup (Edit cleaning), a formula column's (Edit formula) or a lookup
// column's (Edit lookup). The body mounts afresh on
// each open, so every open starts clean.
export const NewColumnModal: React.FC<NewColumnModalProps> = ({ isOpen, onClose, onSubmit, setup }) => (
  <Modal isOpen={isOpen} onClose={onClose} panelClassName="max-w-xl">
    <NewColumnBody onClose={onClose} onSubmit={onSubmit} setup={setup} />
  </Modal>
)

const NewColumnBody: React.FC<Omit<NewColumnModalProps, 'isOpen'>> = ({ onClose, onSubmit, setup }) => {
  // Read once: what the dialog opened on (a reload while it's open doesn't change it).
  const [request] = useState(setup?.request ?? null)
  const formulaReq = isFormulaTarget(request) ? request : null
  const lookupReq = isLookupTarget(request) ? request : null
  const cleanReq = request && !formulaReq && !lookupReq ? request as CleanOpenTarget : null
  const [editingClean] = useState(() => (
    cleanReq?.mode === 'edit' ? setup?.cleanColumns[cleanReq.column] ?? null : null))
  const [editingFormula] = useState(() => (
    formulaReq?.mode === 'formula-edit' ? setup?.formulaColumns[formulaReq.column] ?? null : null))
  const [editingLookup] = useState(() => (
    lookupReq?.mode === 'lookup-edit' ? setup?.lookupColumns[lookupReq.column] ?? null : null))
  const [choice, setChoice] = useState<Choice>(
    formulaReq ? 'formula' : lookupReq ? 'lookup' : cleanReq ? 'clean' : 'empty')
  const editing = editingClean ?? editingFormula ?? editingLookup
  const subtitle = editingClean
    ? `"${editingClean.column}" is cleaned from "${editingClean.source}". Saving cleans every row again.`
    : editingFormula ? `"${editingFormula.column}" is worked out from each row. Saving works every row out again.`
      : editingLookup ? `"${editingLookup.column}" is looked up in another sheet. Saving looks every row up again.`
        : 'Create a new column in this sheet'
  return (
    <>
      <div className="p-6 border-b border-gray-200">
        <h3 className="text-title text-gray-900">
          {editingClean ? 'Edit cleaning' : editingFormula ? 'Edit formula'
            : editingLookup ? 'Edit lookup' : 'Add Column'}
        </h3>
        <p className="text-sm text-gray-600 mt-1">{subtitle}</p>
      </div>
      <div className="p-6 space-y-4">
        {setup && !editing && (
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
        {setup && choice === 'clean' ? (
          <CleanColumnForm sheetId={setup.sheetId} columns={setup.columns} editing={editingClean}
            initialSource={cleanReq?.mode === 'create' ? cleanReq.source : undefined}
            onCancel={onClose} onStarted={setup.onStarted} />
        ) : setup && choice === 'formula' ? (
          <FormulaColumnForm sheetId={setup.sheetId} columns={setup.columns} editing={editingFormula}
            onCancel={onClose} onStarted={setup.onFormulaStarted} />
        ) : setup && choice === 'lookup' ? (
          <LookupColumnForm sheetId={setup.sheetId} columns={setup.columns} editing={editingLookup}
            onCancel={onClose} onStarted={setup.onLookupStarted} />
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
