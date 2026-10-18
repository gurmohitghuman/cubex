import React, { useEffect, useState } from 'react'
import { lookupAPI, type LookupTarget } from '@/utils/api'
import type { LookupChoices } from '@/utils/api/waterfall'
import { LOOKUP_CONTAINS_MIN_CHARS } from '@/lib/constants'
import type { DraftInput } from './draft'

interface Props {
  sheetId: string
  choices: LookupChoices
  inputs: DraftInput[]
  resultLabel: string
  onChange: (choices: LookupChoices, sheetName?: string) => void
}

const LABEL = 'block text-xs font-medium text-gray-700 mb-1'

// A lookup step (free): the first row of another sheet (any table) whose
// column matches one of the waterfall's inputs, exactly or anywhere inside it;
// its value in another column is the answer. No match: the next step runs.
// A column picked before that isn't in that sheet any more shows as deleted.
export const LookupStepEditor: React.FC<Props> = ({ sheetId, choices: c, inputs, resultLabel, onChange }) => {
  const [targets, setTargets] = useState<LookupTarget[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    lookupAPI.targets(sheetId)
      .then(t => { if (live) setTargets(t) })
      .catch(e => { if (live) setError(e?.response?.data?.error ?? "Couldn't list the other sheets.") })
    return () => { live = false }
  }, [sheetId])
  const other = targets?.find(t => t.sheetId === c.sheetId) ?? null
  const tables = [...new Set((targets ?? []).map(t => t.tableName))]
  const columns = other?.columns ?? []
  const column = (value: string, label: string, testId: string, set: (v: string) => void) => (
    <select className="input w-full" value={value} disabled={!other} aria-label={label} data-testid={testId}
      onChange={e => set(e.target.value)}>
      {!value && <option value="" disabled>Its column</option>}
      {value && other && !columns.includes(value) && <option value={value} disabled>{value} (deleted)</option>}
      {columns.map(col => <option key={col} value={col}>{col}</option>)}
    </select>
  )
  if (targets && targets.length === 0) {
    return <p className="text-xs text-gray-600">A lookup reads another sheet. Add a sheet with the values first.</p>
  }
  return (
    <div className="space-y-2" data-testid="waterfall-lookup-step">
      <div>
        <label htmlFor="wf-lookup-sheet" className={LABEL}>Look in</label>
        <select id="wf-lookup-sheet" className="input w-full" value={c.sheetId} data-testid="wf-lookup-sheet"
          onChange={e => onChange({ ...c, sheetId: e.target.value, matchColumn: '', returnColumn: '' },
            targets?.find(t => t.sheetId === e.target.value)?.sheetName)}>
          {(!c.sheetId || (targets && !other)) && (
            <option value={c.sheetId} disabled>
              {!targets ? 'Loading the sheets…' : c.sheetId ? 'A deleted sheet' : 'Pick a sheet'}
            </option>
          )}
          {tables.map(t => (
            <optgroup key={t} label={t}>
              {targets!.filter(s => s.tableName === t)
                .map(s => <option key={s.sheetId} value={s.sheetId}>{s.sheetName}</option>)}
            </optgroup>
          ))}
        </select>
        {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
        <div>
          <span className={LABEL}>First row where</span>
          {column(c.matchColumn, 'Column it matches', 'wf-lookup-match-column',
            v => onChange({ ...c, matchColumn: v }))}
        </div>
        <select className="input" value={c.mode} aria-label="How it matches"
          onChange={e => onChange({ ...c, mode: e.target.value as LookupChoices['mode'] })}>
          <option value="equals">is exactly</option>
          <option value="contains">contains</option>
        </select>
        <div>
          <span className={LABEL}>the input</span>
          <select className="input w-full" value={c.inputKey} aria-label="Input it looks for"
            data-testid="wf-lookup-input" onChange={e => onChange({ ...c, inputKey: e.target.value })}>
            {!c.inputKey && <option value="" disabled>Input</option>}
            {c.inputKey && !inputs.some(i => i.key === c.inputKey) && (
              <option value={c.inputKey} disabled>{c.inputKey} (not an input)</option>
            )}
            {inputs.map(i => <option key={i.key} value={i.key}>{i.label}</option>)}
          </select>
        </div>
      </div>
      <div>
        <span className={LABEL}>The {resultLabel.toLowerCase()} is its</span>
        {column(c.returnColumn, 'Column it returns', 'wf-lookup-return-column',
          v => onChange({ ...c, returnColumn: v }))}
      </div>
      <p className="text-xs text-gray-500">
        Free. Capital letters and spaces around the value don&apos;t matter
        {c.mode === 'contains' ? `; contains finds it anywhere in the cell (${LOOKUP_CONTAINS_MIN_CHARS} or more `
          + 'characters)' : ''}. No match, and the next step runs. Put it first to skip paid steps for rows you
        already have.
      </p>
    </div>
  )
}
