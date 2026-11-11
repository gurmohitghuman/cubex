import { useMemo, useState } from 'react'
import { cleanAPI, type CleanColumnBody, type CleanColumnView, type CleanStartResult } from '@/utils/api'
import type { CleanOptions } from '@/utils/api/clean'
import {
  DEFAULT_PHONE_COUNTRY, DEFAULT_PHONE_FORMAT, defaultCleanColumnName, isCleanerId,
  type CleanerId, type PhoneFormat, type TheCompany,
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

// The Clean data form: source, cleaner, the phone options, what a first- or
// last-name column holds, what "The ... Company" becomes, the new column's
// name (the default until the person types their own), auto-run, the live
// preview, and the submit (its error stays in the form).
export function useCleanForm({ sheetId, editing, initialSource, onStarted }: Args) {
  const [source, setSource] = useState(editing?.source ?? initialSource ?? '')
  const [cleaner, setCleaner] = useState<CleanerId | ''>(
    editing && isCleanerId(editing.cleaner) ? editing.cleaner : '')
  const [phoneFormat, setPhoneFormat] = useState<PhoneFormat>(editing?.options.phoneFormat ?? DEFAULT_PHONE_FORMAT)
  const [country, setCountryText] = useState(editing?.options.phoneCountry ?? DEFAULT_PHONE_COUNTRY)
  // The column holds only first names (first-name cleaner) or only last names (last-name cleaner).
  const [partOnly, setPartOnly] = useState(
    editing?.options.nameInput === 'first_name' || editing?.options.nameInput === 'last_name')
  const [theCompany, setTheCompany] = useState<TheCompany>(editing?.options.theCompany ?? 'strip')
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
  // name takes the default; options go only to the cleaner that takes them,
  // and the name and company ones only when they aren't the default.
  const body = useMemo((): CleanColumnBody | null => {
    if (!source || !cleaner) return null
    const column = name.trim()
    let options: CleanOptions | null = null
    if (cleaner === 'phone') options = { phoneFormat, ...(country ? { phoneCountry: country } : {}) }
    // name_input is named after the part the column holds, as the cleaner is.
    if ((cleaner === 'first_name' || cleaner === 'last_name') && partOnly) options = { nameInput: cleaner }
    if (cleaner === 'company_name' && theCompany === 'keep') options = { theCompany }
    return { source, cleaner, ...(column ? { column } : {}), ...(options ? { options } : {}) }
  }, [source, cleaner, name, phoneFormat, country, partOnly, theCompany])
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
    partOnly, setPartOnly, theCompany, setTheCompany, name, defaultName, setName: setTypedName, autoRun, setAutoRun,
    preview, ready: !!body, submitting, error, submit,
  }
}
