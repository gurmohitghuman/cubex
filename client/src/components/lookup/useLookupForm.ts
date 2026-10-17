import { useEffect, useMemo, useState } from 'react'
import {
  lookupAPI, type LookupColumnBody, type LookupColumnView, type LookupMatch, type LookupReturns,
  type LookupStartResult, type LookupTarget,
} from '@/utils/api'
import { LOOKUP_LIST_DEFAULT } from '@/lib/constants'
import { defaultLookupName } from './lookup-copy'
import { useLookupPreview } from './useLookupPreview'

// What the column menu opens the Add Column dialog on: a new lookup column, or one's setup to edit.
export type LookupOpenTarget = { mode: 'lookup-new' } | { mode: 'lookup-edit'; column: string }

interface Args {
  sheetId: string
  // The lookup column being edited: its name stays, and saving looks every row up again.
  editing: LookupColumnView | null
  onStarted: (result: LookupStartResult) => void
}

// The Lookup form: the sheet to look in (any table), this row's column and
// the other sheet's column it matches (is exactly / contains), what to write,
// the new column's name (a default until the person types one), auto-run, the
// live preview, and the submit (its error stays in the form).
export function useLookupForm({ sheetId, editing, onStarted }: Args) {
  const [targets, setTargets] = useState<LookupTarget[] | null>(null)
  const [targetsError, setTargetsError] = useState<string | null>(null)
  const [otherSheetId, setOtherSheetId] = useState(editing?.otherSheet ? editing.otherSheetId : '')
  const [sourceColumn, setSourceColumn] = useState(editing?.sourceColumn ?? '')
  const [matchColumn, setMatchColumn] = useState(editing?.otherSheet ? editing.matchColumn : '')
  const [match, setMatch] = useState<LookupMatch>(editing?.match ?? 'equals')
  const [returns, setReturns] = useState<LookupReturns>(editing?.returns ?? 'value')
  const [returnColumn, setReturnColumn] = useState(editing?.returns === 'value' ? editing.returnColumns?.[0] ?? '' : '')
  // 'list': null = every column of the other sheet.
  const [listColumns, setListColumns] = useState<string[] | null>(
    editing?.returns === 'list' ? editing.returnColumns : null)
  const [limit, setLimit] = useState(editing?.returns === 'list' ? editing.limit : LOOKUP_LIST_DEFAULT)
  const [typedName, setTypedName] = useState<string | null>(null)
  const [autoRun, setAutoRun] = useState(editing ? editing.autoRun : true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    lookupAPI.targets(sheetId)
      .then(t => { if (live) setTargets(t) })
      .catch(e => { if (live) setTargetsError(e?.response?.data?.error ?? "Couldn't list the other sheets.") })
    return () => { live = false }
  }, [sheetId])

  const other = targets?.find(t => t.sheetId === otherSheetId) ?? null
  const pickSheet = (id: string) => {
    setOtherSheetId(id)
    // The columns picked belong to the old sheet.
    setMatchColumn(''); setReturnColumn(''); setListColumns(null)
  }

  const defaultName = defaultLookupName(returns, other?.sheetName ?? '', returnColumn)
  const name = editing ? editing.column : typedName ?? defaultName

  // A column picked before that isn't there any more (deleted in the other
  // sheet, or here): shown as such, and nothing is sent until another is picked.
  const otherHas = (c: string) => !other || other.columns.includes(c)
  const missing = !!other && (!otherHas(matchColumn) || (returns === 'value' && !otherHas(returnColumn))
    || (returns === 'list' && !!listColumns?.some(c => !otherHas(c))))

  // What the server is sent, for the preview and the submit alike.
  const body = useMemo((): LookupColumnBody | null => {
    if (!otherSheetId || !sourceColumn || !matchColumn || missing) return null
    if (returns === 'value' && !returnColumn) return null
    if (returns === 'list' && listColumns !== null && listColumns.length === 0) return null
    const column = name.trim()
    return {
      ...(column ? { column } : {}), sourceColumn, otherSheetId, matchColumn, match, returns,
      ...(returns === 'value' ? { returnColumn } : {}),
      ...(returns === 'list' ? { limit, ...(listColumns ? { returnColumns: listColumns } : {}) } : {}),
    }
  }, [otherSheetId, sourceColumn, matchColumn, match, returns, returnColumn, listColumns, limit, name, missing])
  const preview = useLookupPreview(sheetId, body)

  const submit = async () => {
    if (!body || submitting) return
    if (!body.column) { setError('Name the new column.'); return }
    setSubmitting(true)
    setError(null)
    try {
      // Editing with the box unchanged leaves auto-run as it is (sending it would lift a pause).
      const run = editing && autoRun === editing.autoRun ? {} : { autoRun }
      onStarted(await lookupAPI.start(sheetId, { ...body, ...run }))
    } catch (e: any) {
      setError(e?.response?.data?.error || "Couldn't set up the lookup. Try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return {
    targets, targetsError, other, otherSheetId, pickSheet, sourceColumn, setSourceColumn, matchColumn, setMatchColumn,
    match, setMatch, returns, setReturns, returnColumn, setReturnColumn, listColumns, setListColumns, limit, setLimit,
    name, defaultName, setName: setTypedName, autoRun, setAutoRun, preview, ready: !!body, missing, submitting, error,
    submit,
  }
}
