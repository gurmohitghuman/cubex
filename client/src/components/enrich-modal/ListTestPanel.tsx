import React, { useEffect, useState } from 'react'
import { enrichAPI, type EnrichRunStatus } from '@/utils/api'
import { plural } from '@/lib/utils'
import { fieldsProblem, listRequest, mergePicks, type ListDraft } from './list-draft'
import { ListFieldsPicker } from './ListFieldsPicker'
import { useListFields } from './useListFields'

interface Props {
  sheetId: string
  column: string
  list: ListDraft
  updateList: (patch: Partial<ListDraft>) => void
  status: EnrichRunStatus | null
  running: boolean
  active: boolean
  // The fields picked are saved: the run's progress reads again.
  onAdded: () => void
}

// The Test step of a list job: the fields its results came back with, picked
// here (treg doesn't say what each provider's rows hold before they come
// back), then "Add these rows" for the test's results, or "Run on N more rows"
// below, which adds them too.
export const ListTestPanel: React.FC<Props> = (p) => {
  const progress = p.status?.list ?? null
  const key = `${p.status?.status}:${p.status?.processedRows}:${progress?.added}:${progress?.waitingFields.rows}`
  // A paused test's results already wait: their fields can be picked.
  const busy = p.running && p.status?.status !== 'paused'
  const { choices, error } = useListFields(p.sheetId, p.column, p.active && !busy, key)
  const [adding, setAdding] = useState(false)
  // Saved: the button goes until the results read again (a second click would 409).
  const [sent, setSent] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  useEffect(() => setSent(false), [choices])
  useEffect(() => {
    if (!choices || choices.fields.length === 0) return
    p.updateList({ fields: mergePicks(p.list.fields, choices.fields, choices.kept, p.list.copy) })
  }, [choices]) // eslint-disable-line react-hooks/exhaustive-deps

  const dest = progress?.destName ?? 'the other sheet'
  if (busy) {
    return (
      <p className="text-xs text-gray-600">
        {progress?.fieldsPicked
          ? `${plural(progress.added, 'row')} added to ${dest} so far.`
          : 'You pick the fields to keep once these rows finish.'}
      </p>
    )
  }
  if (error) return <p className="text-xs text-red-600">{error}</p>
  if (!choices) return null
  const waiting = choices.waiting
  const fields = p.list.fields ?? []
  const picked = listRequest(p.list).fields
  // The kept fields and the duplicate check must be complete to add (a test has run).
  const unready = p.list.fields ? fieldsProblem(p.list) : null

  const add = async () => {
    if (!picked || unready) return
    setAdding(true)
    setAddError(null)
    try {
      const dedupePath = listRequest(p.list).dedupePath
      await enrichAPI.pickListFields(p.sheetId, { column: p.column, fields: picked, dedupePath })
      setSent(true)
      p.onAdded()
    } catch (e: any) {
      setAddError(e?.response?.data?.error || "Couldn't save the fields. Try again.")
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="space-y-2 border border-gray-200 p-3" data-testid="enrich-list-test">
      <h4 className="text-sm font-medium text-gray-900">Fields to keep</h4>
      {fields.length === 0 ? (
        <p className="text-xs text-gray-600" data-testid="enrich-list-no-results">
          No test row returned results, so there are no fields to pick yet. Go back to setup and run on the next
          rows{p.list.provider ? ', or pick another provider' : ''}.
        </p>
      ) : (
        <>
          <p className="text-xs text-gray-600">
            These are the fields the results came back with. Each kept field becomes a column of {dest}.
          </p>
          <ListFieldsPicker fields={fields} onChange={f => p.updateList({ fields: f })} results={choices.results}
            dedupePath={p.list.dedupePath} onDedupe={dedupePath => p.updateList({ dedupePath })} />
          {(sent || (choices.kept !== null && waiting.rows === 0)) && (
            <p className="text-xs text-gray-500">Changes apply to the rows the next run adds.</p>
          )}
        </>
      )}
      {waiting.rows > 0 && fields.length > 0 && !sent && (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <p className="text-xs text-gray-700">
            {plural(waiting.results, 'result')} from {plural(waiting.rows, 'row')} wait for these fields.
          </p>
          <button type="button" className="btn-secondary" disabled={!picked || !!unready || adding}
            onClick={() => void add()}
            data-testid="enrich-list-add">
            Add {plural(waiting.results, 'row')} to {dest}
          </button>
        </div>
      )}
      {progress && progress.adding.rows + progress.added > 0 && waiting.rows === 0 && (
        <p className="text-xs text-gray-700" data-testid="enrich-list-progress">
          {progress.adding.results > 0 ? `Adding ${plural(progress.adding.results, 'row')} to ${dest}. ` : ''}
          {progress.added > 0 ? `${plural(progress.added, 'row')} added to ${dest} so far.` : ''}
        </p>
      )}
      {waiting.rows > 0 && unready && !sent && <p className="text-xs text-gray-600">{unready}</p>}
      {addError && <p className="text-xs text-red-600">{addError}</p>}
    </div>
  )
}
