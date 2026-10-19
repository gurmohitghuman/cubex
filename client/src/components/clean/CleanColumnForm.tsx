import React from 'react'
import type { CleanColumnView, CleanStartResult } from '@/utils/api'
import { CLEANERS, CLEANER_GROUPS, cleanerInfo, type CleanerId } from '@/lib/cleaners'
import { Select } from '../ui/Select'
import { useCleanForm } from './useCleanForm'
import { CleanPhoneOptions } from './CleanPhoneOptions'
import { CleanPreview } from './CleanPreview'

interface Props {
  sheetId: string
  columns: string[]
  // Edit cleaning: the clean column's setup (its name stays; saving cleans every row again).
  editing: CleanColumnView | null
  initialSource?: string
  onCancel: () => void
  onStarted: (result: CleanStartResult) => void
}

const LABEL = 'block text-xs font-medium text-gray-700 mb-1'
const enter = (e: React.KeyboardEvent) =>
  e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229

// Clean data: a new column holding a tidy copy of a source column, made for
// free by a cleaner (no AI, no requests). With auto-run on, new rows and rows
// whose source changes are cleaned again on their own.
export const CleanColumnForm: React.FC<Props> = ({ sheetId, columns, editing, initialSource, onCancel, onStarted }) => {
  const f = useCleanForm({ sheetId, editing, initialSource, onStarted })
  const info = f.cleaner ? cleanerInfo(f.cleaner) : undefined
  // A column isn't cleaned into itself; an edited column's source may have left the sheet.
  const sources = columns.filter(c => c !== editing?.column)
  const lostSource = !!f.source && !columns.includes(f.source)
  const existing = !editing && f.preview.result?.existing ? f.preview.result.column : null

  if (sources.length === 0 && !editing) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-gray-600">Add a column with values first, then clean it into a new one.</p>
        <div className="flex justify-end">
          <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4" data-testid="clean-column-form">
      <div>
        <label htmlFor="clean-source" className={LABEL}>Column to clean</label>
        <Select<string> id="clean-source" className="w-full" value={f.source} onChange={f.setSource}
          label="Column to clean" placeholder="Pick a column"
          options={[
            ...(lostSource ? [{ value: f.source, label: `${f.source} (not in the sheet)` }] : []),
            ...sources.map(c => ({ value: c, label: c })),
          ]} />
      </div>
      <div>
        <label htmlFor="clean-cleaner" className={LABEL}>Cleaner</label>
        <Select<string> id="clean-cleaner" className="w-full" value={f.cleaner} label="Cleaner"
          onChange={v => f.setCleaner(v as CleanerId)} placeholder="Pick what the column holds"
          groups={CLEANER_GROUPS.map(g => ({
            label: g,
            options: CLEANERS.filter(c => c.group === g).map(c => ({ value: c.id as string, label: c.label })),
          }))} />
        {info && <p className="text-xs text-gray-500 mt-1" data-testid="clean-cleaner-help">{info.help}</p>}
      </div>
      {f.cleaner === 'phone' && (
        <CleanPhoneOptions format={f.phoneFormat} onFormat={f.setPhoneFormat} country={f.country}
          onCountry={f.setCountry} />
      )}
      <div>
        {editing ? <span className={LABEL}>Column name</span>
          : <label htmlFor="clean-name" className={LABEL}>New column name</label>}
        {editing ? (
          <p className="text-sm text-gray-900">
            {editing.column}
            <span className="block text-xs text-gray-500">To rename it, use Rename column in its menu.</span>
          </p>
        ) : (
          <input id="clean-name" className="input w-full" value={f.name}
            placeholder={f.defaultName || 'e.g. Name (clean)'} onChange={e => f.setName(e.target.value)}
            onKeyDown={e => { if (enter(e)) { e.preventDefault(); void f.submit() } }} />
        )}
        {existing && (
          <p className="text-xs text-amber-700 mt-1">
            &quot;{existing}&quot; is a clean column already: this replaces how it&apos;s cleaned and cleans every
            row again.
          </p>
        )}
      </div>
      <CleanPreview state={f.preview} ready={f.ready} />
      <label className="flex items-start gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={f.autoRun} onChange={e => f.setAutoRun(e.target.checked)}
          className="mt-0.5 border-gray-300 text-cube-black focus:ring-black" data-testid="clean-autorun" />
        <span>
          Keep cleaning new and changed rows
          <span className="block text-xs text-gray-500">
            Free. New rows, and rows whose source changes, are cleaned on their own.
          </span>
        </span>
      </label>
      {f.error && <p className="text-xs text-red-600 text-right" role="alert">{f.error}</p>}
      <div className="flex items-center justify-end gap-3">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <span className="text-xs text-gray-500">Free</span>
        <button type="button" className="btn-primary" disabled={!f.ready || f.submitting}
          onClick={() => void f.submit()} data-testid="clean-submit">
          {f.submitting ? 'Cleaning…' : editing ? 'Save and clean every row' : 'Clean column'}
        </button>
      </div>
    </div>
  )
}
