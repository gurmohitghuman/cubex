import React from 'react'
import type { LookupColumnView, LookupMatch, LookupStartResult } from '@/utils/api'
import { LOOKUP_CONTAINS_MIN_CHARS } from '@/lib/constants'
import { useLookupForm } from './useLookupForm'
import { LookupReturnsFields } from './LookupReturnsFields'
import { LookupPreview } from './LookupPreview'

interface Props {
  sheetId: string
  columns: string[]
  // Edit lookup: the lookup column's setup (its name stays; saving looks every row up again).
  editing: LookupColumnView | null
  onCancel: () => void
  onStarted: (result: LookupStartResult) => void
}

const LABEL = 'block text-xs font-medium text-gray-700 mb-1'

// A lookup column: a new column filled for free from another sheet. Each row's
// value is matched against a column there (exactly, or anywhere inside it),
// and the column gets a column of the first match, yes/no, a count or the
// matches. Changes in the other sheet don't update it; with auto-run on, new
// rows and rows whose value changes are looked up on their own.
export const LookupColumnForm: React.FC<Props> = ({ sheetId, columns, editing, onCancel, onStarted }) => {
  const f = useLookupForm({ sheetId, editing, onStarted })
  const sources = columns.filter(c => c !== editing?.column)
  const existing = !editing && f.preview.result?.existing ? f.preview.result.column : null
  const tables = [...new Set((f.targets ?? []).map(t => t.tableName))]
  const otherColumns = f.other?.columns ?? []

  if (f.targets && f.targets.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-gray-600">A lookup reads another sheet. Add a sheet with the values first.</p>
        <div className="flex justify-end">
          <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4" data-testid="lookup-column-form">
      {editing && <LookupStatus view={editing} />}
      <div>
        <label htmlFor="lookup-sheet" className={LABEL}>Look in</label>
        <select id="lookup-sheet" className="input w-full" value={f.otherSheetId}
          onChange={e => f.pickSheet(e.target.value)} data-testid="lookup-sheet">
          {!f.otherSheetId && <option value="" disabled>{f.targets ? 'Pick a sheet' : 'Loading the sheets…'}</option>}
          {tables.map(t => (
            <optgroup key={t} label={t}>
              {f.targets!.filter(s => s.tableName === t)
                .map(s => <option key={s.sheetId} value={s.sheetId}>{s.sheetName}</option>)}
            </optgroup>
          ))}
        </select>
        {f.targetsError && <p className="text-xs text-red-600 mt-1">{f.targetsError}</p>}
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
        <div>
          <label htmlFor="lookup-match-column" className={LABEL}>Find rows where</label>
          <select id="lookup-match-column" className="input w-full" value={f.matchColumn} disabled={!f.other}
            onChange={e => f.setMatchColumn(e.target.value)} data-testid="lookup-match-column">
            {!f.matchColumn && <option value="" disabled>Its column</option>}
            {f.matchColumn && f.other && !otherColumns.includes(f.matchColumn) && (
              <option value={f.matchColumn} disabled>{f.matchColumn} (deleted)</option>
            )}
            {otherColumns.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <select className="input" value={f.match} aria-label="How it matches"
          onChange={e => f.setMatch(e.target.value as LookupMatch)} data-testid="lookup-match">
          <option value="equals">is exactly</option>
          <option value="contains">contains</option>
        </select>
        <div>
          <label htmlFor="lookup-source" className={LABEL}>this row&apos;s</label>
          <select id="lookup-source" className="input w-full" value={f.sourceColumn}
            onChange={e => f.setSourceColumn(e.target.value)} data-testid="lookup-source">
            {!f.sourceColumn && <option value="" disabled>Column</option>}
            {f.sourceColumn && !sources.includes(f.sourceColumn) && (
              <option value={f.sourceColumn} disabled>{f.sourceColumn} (not in this sheet)</option>
            )}
            {sources.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <p className="text-xs text-gray-500">
        Capital letters and spaces around the value don&apos;t matter.
        {f.match === 'contains' && ' Contains finds the value anywhere in the other cell '
          + `(${LOOKUP_CONTAINS_MIN_CHARS} or more characters, in the first 1,000 characters of each cell). `
          + 'On very large sheets it can take a few minutes.'}
      </p>
      <LookupReturnsFields columns={otherColumns} returns={f.returns} onReturns={f.setReturns}
        returnColumn={f.returnColumn} onReturnColumn={f.setReturnColumn} listColumns={f.listColumns}
        onListColumns={f.setListColumns} limit={f.limit} onLimit={f.setLimit} />
      <div>
        {editing ? <span className={LABEL}>Column name</span>
          : <label htmlFor="lookup-name" className={LABEL}>New column name</label>}
        {editing ? (
          <p className="text-sm text-gray-900">
            {editing.column}
            <span className="block text-xs text-gray-500">To rename it, use Rename column in its menu.</span>
          </p>
        ) : (
          <input id="lookup-name" className="input w-full" value={f.name}
            placeholder={f.defaultName || 'e.g. Industry'} onChange={e => f.setName(e.target.value)}
            data-testid="lookup-name" />
        )}
        {existing && (
          <p className="text-xs text-amber-700 mt-1">
            &quot;{existing}&quot; is a lookup column already: this replaces how it looks up and looks every row
            up again.
          </p>
        )}
      </div>
      {f.missing && (
        <p className="text-xs text-amber-700" data-testid="lookup-missing">
          A column it reads isn&apos;t in &quot;{f.other?.sheetName}&quot; any more. Pick another one.
        </p>
      )}
      <LookupPreview state={f.preview} ready={f.ready} />
      <p className="text-xs text-gray-500">
        Changes in the other sheet don&apos;t update this column. Use Look up again in its menu when they should.
      </p>
      <label className="flex items-start gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={f.autoRun} onChange={e => f.setAutoRun(e.target.checked)}
          className="mt-0.5 border-gray-300 text-cube-black focus:ring-black" data-testid="lookup-autorun" />
        <span>
          Keep looking up new and changed rows
          <span className="block text-xs text-gray-500">
            Free. New rows, and rows whose {f.sourceColumn ? `"${f.sourceColumn}"` : 'value'} changes, are looked up on
            their own.
          </span>
        </span>
      </label>
      {f.error && <p className="text-xs text-red-600 text-right" role="alert">{f.error}</p>}
      <div className="flex items-center justify-end gap-3">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <span className="text-xs text-gray-500">Free</span>
        <button type="button" className="btn-primary" disabled={!f.ready || f.submitting}
          onClick={() => void f.submit()} data-testid="lookup-submit">
          {f.submitting ? 'Saving…' : editing ? 'Save and look up every row' : 'Add lookup column'}
        </button>
      </div>
    </div>
  )
}

// Edit lookup: why it stopped (the other sheet or a column gone, a failed
// fill), the first row that showed an error, what a fill waits for, and why
// auto-run is paused.
const LookupStatus: React.FC<{ view: LookupColumnView }> = ({ view }) => {
  const notes = [
    view.broken ? `${view.broken} Pick the sheet and columns again.` : null,
    view.status === 'failed' && !view.broken ? `It stopped${view.error ? `: ${view.error}` : '.'}` : null,
    view.status === 'filling' && view.waiting ? view.waiting : null,
    view.status === 'done' && view.errorRows > 0
      ? `${view.errorRows === 1 ? '1 row shows' : `${view.errorRows} rows show`} an error.`
        + (view.firstError ? ` The first: ${view.firstError}` : '')
      : null,
    view.autoRunNote ? `Auto-run is paused: ${view.autoRunNote}` : null,
  ].filter((n): n is string => !!n)
  if (notes.length === 0) return null
  return (
    <div className="border border-amber-300 bg-amber-50 px-3 py-2 space-y-1" data-testid="lookup-status">
      {notes.map(n => <p key={n} className="text-xs text-amber-800">{n}</p>)}
    </div>
  )
}
