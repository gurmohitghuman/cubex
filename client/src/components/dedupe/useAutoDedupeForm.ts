import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { toastBlocked } from '@/components/sheet/blockedToast'
import {
  autoDedupeAPI, trashAPI, type AutoDedupeKeep, type AutoDedupeView, type CleanColumnView, type ColumnType,
} from '@/utils/api'
import { guessDedupeMatch, isPeopleSheet, pickDedupeKeys, type DedupeMatch } from '@/lib/dedupe'
import { AUTO_DEDUPE_POLL_MS } from '@/lib/constants'

interface Args {
  sheetId: string
  columns: string[]
  columnTypes: Record<string, ColumnType>
  cleanColumns: Record<string, CleanColumnView>
  current: AutoDedupeView | null
  open: boolean
  onChanged: (view: AutoDedupeView | null) => void
}

// A key column is one rows arrive with: plain, or one a webhook fills. A
// column Cubex fills later (AI, HTTP, clean, formula...) is empty when a row
// arrives, so the server refuses it too (services/auto-dedupe-setting.ts).
const arrivesWith = (t: ColumnType | undefined): boolean => !t || t === 'webhook-mapped'

// The Remove duplicates dialog's "As rows arrive" tab: the key column, how it
// matches and which row stays, saved as the sheet's auto-dedupe. While its
// keys are being built or checks wait, it looks again every AUTO_DEDUPE_POLL_MS.
export function useAutoDedupeForm(a: Args) {
  const { sheetId, columns, columnTypes, cleanColumns, current, open, onChanged } = a
  const eligible = columns.filter(c => arrivesWith(columnTypes[c]))
  const people = isPeopleSheet(columns)
  const [column, setColumnState] = useState('')
  const [match, setMatch] = useState<DedupeMatch>('text')
  const [keep, setKeep] = useState<AutoDedupeKeep>('oldest')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // How long the trash keeps things (0: what auto-dedupe removes is gone for good).
  const [trashDays, setTrashDays] = useState<number | null>(null)
  useEffect(() => {
    if (open) trashAPI.getDays().then(t => setTrashDays(t.days)).catch(() => setTrashDays(null))
  }, [open])

  // Each opening starts from the setting, or the column that tells rows apart best.
  useEffect(() => {
    if (!open) return
    setError(null)
    if (current) {
      setColumnState(current.column); setMatch(current.match); setKeep(current.keep)
      return
    }
    const best = pickDedupeKeys(eligible, c => cleanColumns[c]?.cleaner)[0]
    setColumnState(best?.column ?? ''); setMatch(best?.match ?? 'text'); setKeep('oldest')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const settling = !!current && (current.state === 'building' || current.waiting_rows > 0)
  useEffect(() => {
    if (!open || !settling) return
    const t = setTimeout(() => { autoDedupeAPI.get(sheetId).then(onChanged).catch(() => {}) }, AUTO_DEDUPE_POLL_MS)
    return () => clearTimeout(t)
  }, [open, settling, current, sheetId, onChanged])

  const setColumn = (c: string) => {
    setColumnState(c)
    setMatch(guessDedupeMatch(c, cleanColumns[c]?.cleaner, people))
  }
  const changed = !current || current.column !== column || current.match !== match || current.keep !== keep
  // How bare phone numbers are read (set over the API or MCP): kept while the column and match stay.
  const country = current && current.column === column && current.match === 'phone' && match === 'phone'
    ? current.phone_country : null

  const run = async (work: () => Promise<AutoDedupeView | null>, done: string) => {
    setSaving(true)
    setError(null)
    try {
      onChanged(await work())
      toast.success(done)
    } catch (e: any) {
      const status: number | undefined = e?.response?.status
      if (status === 409) toastBlocked(e, "Couldn't change auto-dedupe")
      else setError(e?.response?.data?.error || "Couldn't save auto-dedupe.")
    } finally {
      setSaving(false)
    }
  }
  return {
    eligible, column, match, keep, country, setColumn, setMatch, setKeep, saving, error, changed, trashDays,
    save: () => run(() => autoDedupeAPI.set(sheetId,
      { column, match, keep, ...(country ? { phone_country: country } : {}) }),
      current ? 'Auto-dedupe saved' : 'Auto-dedupe is on'),
    turnOff: () => run(() => autoDedupeAPI.off(sheetId), 'Auto-dedupe is off'),
  }
}

export type AutoDedupeForm = ReturnType<typeof useAutoDedupeForm>
