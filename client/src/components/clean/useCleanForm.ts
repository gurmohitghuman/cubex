import { useMemo, useState } from 'react'
import { cleanAPI, type CleanColumnBody, type CleanColumnView, type CleanStartResult } from '@/utils/api'
import {
  DEFAULT_PHONE_COUNTRY, DEFAULT_PHONE_FORMAT, defaultCleanColumnName, isCleanerId,
  type CleanerId, type PhoneFormat,
} from '@/lib/cleaners'
import { useCleanPreview } from './useCleanPreview'

// What the column menu opens the Add Column dialog on: Clean data with that
// column as the source ("Clean data…"), or a clean column's setup ("Edit cleaning…").
export type CleanOpenTarget = { mode: 'create'; source?: string } | { mode: 'edit'; column: string }

interface Args {
  sheetId: string
  // The clean column being edited: its name stays, and saving cleans every row again.
  editing: CleanColumnView | null
  initialSource?: string
  onStarted: (result: CleanStartResult) => void
}

// The Clean data form: source, cleaner, the phone options, the new column's
// name (the default until the person types their own), auto-run, the live
// preview, and the submit (its error stays in the form).
export function useCleanForm({ sheetId, editing, initialSource, onStarted }: Args) {
  const [source, setSource] = useState(editing?.source ?? initialSource ?? '')
  const [cleaner, setCleaner] = useState<CleanerId | ''>(
    editing && isCleanerId(editing.cleaner) ? editing.cleaner : '')
  const [phoneFormat, setPhoneFormat] = useState<PhoneFormat>(editing?.options.phoneFormat ?? DEFAULT_PHONE_FORMAT)
  const [country, setCountryText] = useState(editing?.options.phoneCountry ?? DEFAULT_PHONE_COUNTRY)
  // null: the name follows the source and cleaner (the same default the server uses).
  const [typedName, setTypedName] = useState<string | null>(null)
  const [autoRun, setAutoRun] = useState(editing ? editing.autoRun : true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const defaultName = source && cleaner ? defaultCleanColumnName(cleaner, source) : ''
  const name = editing ? editing.column : typedName ?? defaultName
  // Two letters, upper case (the server checks it's a real country).
  const setCountry = (v: string) => setCountryText(v.replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase())

  // What the server is sent, for the preview and the submit alike. An empty
  // name takes the default; only the phone cleaner takes options.
  const body = useMemo((): CleanColumnBody | null => {
    if (!source || !cleaner) return null
    const column = name.trim()
    const options = { phoneFormat, ...(country ? { phoneCountry: country } : {}) }
    return { source, cleaner, ...(column ? { column } : {}), ...(cleaner === 'phone' ? { options } : {}) }
  }, [source, cleaner, name, phoneFormat, country])
  const preview = useCleanPreview(sheetId, body)

  const submit = async () => {
    if (!body || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      // Editing with the box unchanged leaves auto-run as it is: sending it on
      // would lift a pause (Pause all auto-runs).
      const run = editing && autoRun === editing.autoRun ? {} : { autoRun }
      onStarted(await cleanAPI.start(sheetId, { ...body, ...run }))
    } catch (e: any) {
      setError(e?.response?.data?.error || "Couldn't clean the column. Try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return {
    source, setSource, cleaner, setCleaner, phoneFormat, setPhoneFormat, country, setCountry,
    name, defaultName, setName: setTypedName, autoRun, setAutoRun,
    preview, ready: !!body, submitting, error, submit,
  }
}
