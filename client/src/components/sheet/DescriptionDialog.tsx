import React, { useEffect, useState } from 'react'
import Modal from '@/components/Modal'
import { MAX_COLUMN_DESCRIPTION_CHARS, MAX_SHEET_DESCRIPTION_CHARS } from '@/lib/constants'
import type { DescriptionTarget } from '@/hooks/sheet/useDescriptions'

interface Props {
  target: DescriptionTarget | null
  initial: string
  onClose: () => void
  onSave: (text: string) => Promise<boolean>
}

// A column's or a sheet's description: a few words on what it holds, shown on
// the column header or the sheet's tab, and read by agents connected to Cubex.
// Saving it empty removes it.
export const DescriptionDialog: React.FC<Props> = ({ target, initial, onClose, onSave }) => {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  // The saved text when it opens: a reload while typing (an agent changing it) never wipes what is typed.
  useEffect(() => {
    if (!target) return
    setText(initial)
    setSaving(false)
  }, [target]) // eslint-disable-line react-hooks/exhaustive-deps

  const max = target?.kind === 'sheet' ? MAX_SHEET_DESCRIPTION_CHARS : MAX_COLUMN_DESCRIPTION_CHARS
  const name = target?.kind === 'sheet' ? target.sheet.name : target?.column ?? ''
  const save = async (value: string) => {
    if (saving) return
    setSaving(true)
    const done = await onSave(value)
    setSaving(false)
    if (done) onClose()
  }

  return (
    <Modal isOpen={!!target} onClose={() => { if (!saving) onClose() }} panelClassName="max-w-md w-full">
      <form onSubmit={e => { e.preventDefault(); void save(text) }} data-testid="description-dialog">
        <div className="p-6 border-b border-gray-200">
          <h3 className="text-title text-gray-900 truncate">
            {target?.kind === 'sheet' ? 'Sheet description' : 'Column description'}: {name}
          </h3>
          <p className="text-sm text-gray-600 mt-1">
            {target?.kind === 'sheet'
              ? 'What this sheet is for. It shows when you point at its tab.'
              : 'What this column holds, where its values come from, or how to read them. It shows when you '
                + 'point at the column\'s name.'}
            {' '}Agents connected to Cubex read it too. It is never added to AI prompts.
          </p>
        </div>
        <div className="p-6">
          <textarea className="input w-full min-h-[120px] resize-y" value={text} maxLength={max} autoFocus
            onChange={e => setText(e.target.value)} data-testid="description-text"
            placeholder={target?.kind === 'sheet'
              ? 'Inbound leads from the website form, one row per signup'
              : 'Work email found by the enrichment, checked for delivery'} />
          <p className="text-xs text-gray-500 mt-1 text-right">
            {text.length.toLocaleString('en-US')} / {max.toLocaleString('en-US')}
          </p>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex items-center gap-2">
          {initial && (
            <button type="button" className="btn-secondary text-red-600" disabled={saving}
              onClick={() => void save('')} data-testid="description-remove">Remove</button>
          )}
          <div className="flex-1" />
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving || text === initial}
            data-testid="description-save">Save</button>
        </div>
      </form>
    </Modal>
  )
}
