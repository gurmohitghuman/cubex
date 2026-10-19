import React, { useLayoutEffect, useRef } from 'react'
import type { FormulaColumnView, FormulaStartResult } from '@/utils/api'
import { useFormulaForm } from './useFormulaForm'
import { FormulaWriter } from './FormulaWriter'
import { FormulaPreview } from './FormulaPreview'

interface Props {
  sheetId: string
  columns: string[]
  // Edit formula: the formula column's setup (its name stays; saving works every row out again).
  editing: FormulaColumnView | null
  onCancel: () => void
  onStarted: (result: FormulaStartResult) => void
}

const LABEL = 'block text-xs font-medium text-gray-700 mb-1'
const EXAMPLE = '{{Response}}?.emails?.find(e => e.type == "work")?.value'

// A formula column: a new column worked out for free from each row by one
// JavaScript expression reading cells as {{Column}}. Describe it
// and AI writes the formula once, or write it yourself. With auto-run on, new
// rows and rows where a column it reads changes are worked out on their own.
export const FormulaColumnForm: React.FC<Props> = ({ sheetId, columns, editing, onCancel, onStarted }) => {
  const f = useFormulaForm({ sheetId, editing, onStarted })
  const box = useRef<HTMLTextAreaElement>(null)
  // Where the cursor goes once an inserted {{Name}} is on screen: set in the
  // same commit, so a key typed right after lands after the reference.
  const caret = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (caret.current === null || !box.current) return
    box.current.focus()
    box.current.setSelectionRange(caret.current, caret.current)
    caret.current = null
  }, [f.formula])
  const existing = !editing && f.preview.result?.existing ? f.preview.result.column : null
  const readable = columns.filter(c => c !== editing?.column)

  // "Insert a column": {{Name}} at the cursor (or the end), then the cursor after it.
  const insert = (column: string) => {
    const el = box.current
    const ref = `{{${column}}}`
    const at = el ? [el.selectionStart, el.selectionEnd] : [f.formula.length, f.formula.length]
    caret.current = at[0] + ref.length
    f.setFormula(f.formula.slice(0, at[0]) + ref + f.formula.slice(at[1]))
  }

  return (
    <div className="space-y-4" data-testid="formula-column-form">
      {editing && <FormulaStatus view={editing} />}
      <div>
        {editing ? <span className={LABEL}>Column name</span>
          : <label htmlFor="formula-name" className={LABEL}>New column name</label>}
        {editing ? (
          <p className="text-sm text-gray-900">
            {editing.column}
            <span className="block text-xs text-gray-500">To rename it, use Rename column in its menu.</span>
          </p>
        ) : (
          <input id="formula-name" className="input w-full" value={f.name} placeholder="e.g. Work email"
            onChange={e => f.setName(e.target.value)} autoFocus />
        )}
        {existing && (
          <p className="text-xs text-amber-700 mt-1">
            &quot;{existing}&quot; is a formula column already: this replaces its formula and works every row out
            again.
          </p>
        )}
      </div>
      <FormulaWriter sheetId={sheetId} initialWords={editing?.description ?? null}
        onWritten={(out, words) => { f.setFormula(out.formula); f.setDescription(words) }} />
      <div>
        <div className="flex items-center justify-between mb-1">
          <label htmlFor="formula-text" className="block text-xs font-medium text-gray-700">Formula</label>
          <select className="select-compact text-xs border border-gray-200 bg-white px-1 py-0.5" value=""
            aria-label="Insert a column" data-testid="formula-insert"
            onChange={e => { if (e.target.value) insert(e.target.value) }}>
            <option value="">Insert a column…</option>
            {readable.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {/* No ligatures: "=>" and "==" stay the characters that were typed. */}
        <textarea id="formula-text" ref={box} className="input w-full font-mono text-xs" rows={3} spellCheck={false}
          value={f.formula} onChange={e => f.setFormula(e.target.value)} placeholder={EXAMPLE}
          style={{ fontVariantLigatures: 'none' }} data-testid="formula-text" />
        <p className="text-xs text-gray-500 mt-1">
          One JavaScript expression. Cells are text (use Number() for math), and a cell holding JSON, like an API
          response, arrives as an object or a list. _ is Lodash.
        </p>
      </div>
      <FormulaPreview state={f.preview} ready={!!f.formula.trim()} />
      <label className="flex items-start gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={f.autoRun} onChange={e => f.setAutoRun(e.target.checked)}
          className="mt-0.5 border-gray-300 text-cube-black focus:ring-black" data-testid="formula-autorun" />
        <span>
          Keep new and changed rows worked out
          <span className="block text-xs text-gray-500">
            Free. New rows, and rows where a column it reads changes, are worked out on their own.
          </span>
        </span>
      </label>
      {f.error && <p className="text-xs text-red-600 text-right" role="alert">{f.error}</p>}
      <div className="flex items-center justify-end gap-3">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <span className="text-xs text-gray-500">Free</span>
        <button type="button" className="btn-primary" disabled={!f.ready || f.submitting}
          onClick={() => void f.submit()} data-testid="formula-submit">
          {f.submitting ? 'Saving…' : editing ? 'Save and work out every row' : 'Add formula column'}
        </button>
      </div>
    </div>
  )
}

// Edit formula: why the last fill stopped, the first row that showed an
// error, and why auto-run is paused, so the person can fix the formula.
const FormulaStatus: React.FC<{ view: FormulaColumnView }> = ({ view }) => {
  const notes = [
    view.status === 'failed' ? `It stopped${view.error ? `: ${view.error}` : '.'}` : null,
    view.status === 'done' && view.errorRows > 0
      ? `${view.errorRows === 1 ? '1 row shows' : `${view.errorRows} rows show`} an error.`
        + (view.firstError ? ` The first: ${view.firstError}` : '')
      : null,
    view.autoRunNote ? `Auto-run is paused: ${view.autoRunNote}` : null,
  ].filter((n): n is string => !!n)
  if (notes.length === 0) return null
  return (
    <div className="border border-amber-300 bg-amber-50 px-3 py-2 space-y-1" data-testid="formula-status">
      {notes.map(n => <p key={n} className="text-xs text-amber-800">{n}</p>)}
    </div>
  )
}
