import React, { useEffect, useState } from 'react'
import { lookupAPI, type LookupTarget } from '@/utils/api'
import type { LookupChoices } from '@/utils/api/waterfall'
import { LOOKUP_CONTAINS_MIN_CHARS } from '@/lib/constants'
import type { DraftInput } from './draft'
import { Select } from '@/components/ui/Select'

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
    <Select className="w-full" value={value} disabled={!other} label={label} testId={testId}
      onChange={set} placeholder="Its column" options={[
        ...(value && other && !columns.includes(value)
          ? [{ value, label: `${value} (deleted)`, disabled: true }] : []),
        ...columns.map(col => ({ value: col, label: col })),
      ]} />
  )
  if (targets && targets.length === 0) {
    return <p className="text-xs text-gray-600">A lookup reads another sheet. Add a sheet with the values first.</p>
  }
  return (
    <div className="space-y-2" data-testid="waterfall-lookup-step">
      <div>
        <label htmlFor="wf-lookup-sheet" className={LABEL}>Look in</label>
        <Select id="wf-lookup-sheet" className="w-full" value={c.sheetId} testId="wf-lookup-sheet"
          label="Look in" placeholder={!targets ? 'Loading the sheets…' : 'Pick a sheet'}
          onChange={v => onChange({ ...c, sheetId: v, matchColumn: '', returnColumn: '' },
            targets?.find(t => t.sheetId === v)?.sheetName)}
          groups={[
            ...((c.sheetId && (!targets || !other))
              ? [{ label: '', options: [{
                value: c.sheetId, disabled: true, label: !targets ? 'Loading the sheets…' : 'A deleted sheet',
              }] }] : []),
            ...tables.map(t => ({
              label: t,
              options: targets!.filter(s => s.tableName === t).map(s => ({ value: s.sheetId, label: s.sheetName })),
            })),
          ]} />
        {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
        <div>
          <span className={LABEL}>First row where</span>
          {column(c.matchColumn, 'Column it matches', 'wf-lookup-match-column',
            v => onChange({ ...c, matchColumn: v }))}
        </div>
        <Select<string> value={c.mode} label="How it matches"
          onChange={v => onChange({ ...c, mode: v as LookupChoices['mode'] })}
          options={[{ value: 'equals', label: 'is exactly' }, { value: 'contains', label: 'contains' }]} />
        <div>
          <span className={LABEL}>the input</span>
          <Select className="w-full" value={c.inputKey} label="Input it looks for" testId="wf-lookup-input"
            placeholder="Input" onChange={v => onChange({ ...c, inputKey: v })} options={[
              ...(c.inputKey && !inputs.some(i => i.key === c.inputKey)
                ? [{ value: c.inputKey, label: `${c.inputKey} (not an input)`, disabled: true }] : []),
              ...inputs.map(i => ({ value: i.key, label: i.label })),
            ]} />
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
