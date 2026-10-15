import { useCallback, useEffect, useState } from 'react'
import {
  dedupeAPI, type CleanColumnView, type DedupeBody, type DedupeCheckResult, type DedupeColumn,
} from '@/utils/api'
import { guessDedupeMatch, pickDedupeColumn, type DedupeKeep, type DedupeMatch } from '@/lib/dedupe'
import { DEDUPE_CHECK_DELAY_MS } from '@/lib/constants'

export interface DedupeCheckState {
  loading: boolean
  // The newest answer (kept on screen, dimmed, while the next one loads).
  result: DedupeCheckResult | null
  // The server's reason it can't check (the sheet is busy, a column is gone).
  error: string | null
}

const IDLE: DedupeCheckState = { loading: false, result: null, error: null }

// The check: a moment after the choices stop changing, the server works out
// what removing would do (a free read of the whole sheet). A newer choice, or
// closing the dialog, aborts the older request, which stops the server's scan.
function useDedupeCheck(sheetId: string, body: DedupeBody | null, nonce: number): DedupeCheckState {
  const [state, setState] = useState<DedupeCheckState>(IDLE)
  const key = body ? JSON.stringify(body) : ''
  useEffect(() => {
    if (!key) { setState(IDLE); return }
    setState(s => ({ ...s, loading: true }))
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      dedupeAPI.check(sheetId, JSON.parse(key) as DedupeBody, ctrl.signal)
        .then(result => setState({ loading: false, result, error: null }))
        .catch(e => {
          if (ctrl.signal.aborted) return
          setState({ loading: false, result: null, error: e?.response?.data?.error ?? "Couldn't check the sheet." })
        })
    }, DEDUPE_CHECK_DELAY_MS)
    return () => { clearTimeout(timer); ctrl.abort() }
  }, [sheetId, key, nonce])
  return state
}

interface Args { sheetId: string; columns: string[]; cleanColumns: Record<string, CleanColumnView>; open: boolean }

// The Remove duplicates dialog's choices: the columns to match on (each with
// how it matches) and which row of a group stays, plus the live check.
export function useDedupeForm({ sheetId, columns, cleanColumns, open }: Args) {
  const guess = useCallback((column: string): DedupeColumn =>
    ({ column, match: guessDedupeMatch(column, cleanColumns[column]?.cleaner) }), [cleanColumns])
  const [keys, setKeys] = useState<DedupeColumn[]>([])
  const [keep, setKeep] = useState<DedupeKeep>('first')
  const [nonce, setNonce] = useState(0)
  // Each opening starts fresh, on the column that tells rows apart best (lib/dedupe.ts).
  useEffect(() => {
    if (!open) return
    const first = pickDedupeColumn(columns, c => cleanColumns[c]?.cleaner)
    setKeys(first ? [guess(first)] : [])
    setKeep('first')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const body: DedupeBody | null = open && keys.length > 0 ? { columns: keys, keep } : null
  const check = useDedupeCheck(sheetId, body, nonce)
  const unused = columns.filter(c => !keys.some(k => k.column === c))
  return {
    keys, keep, setKeep, body, check, unused,
    setColumn: (i: number, column: string) => setKeys(ks => ks.map((k, j) => (j === i ? guess(column) : k))),
    setMatch: (i: number, match: DedupeMatch) =>
      setKeys(ks => ks.map((k, j) => (j === i ? { column: k.column, match } : k))),
    addColumn: () => { if (unused[0]) setKeys(ks => [...ks, guess(unused[0])]) },
    removeColumn: (i: number) => setKeys(ks => ks.filter((_, j) => j !== i)),
    // Check again (a run that held the sheet was cancelled).
    recheck: () => setNonce(n => n + 1),
  }
}

export type DedupeForm = ReturnType<typeof useDedupeForm>
