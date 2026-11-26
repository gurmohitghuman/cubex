import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { tablesAPI, type Table } from '@/utils/api'
import { waitFor } from '@/lib/wait'

// After a 429 when the answer didn't say (the server holds a runs wait up to 25 s); after any other failure (a
// restart, the network), so a home left open picks the runs up again.
const RETRY_DEFAULT_SEC = 25
const RETRY_AFTER_ERROR_MS = 5_000
// At most one ask a second, as the sheet's change poll: runs that start and end every moment don't make it spin.
const MIN_ASK_MS = 1_000

// The home's Runs column, kept live while the page is open: GET /api/tables/runs answers every table's runs going
// now and paused, then is asked again with the answer's key, and the server holds that request until a run starts,
// ends, pauses or resumes (up to 25 s). A table it doesn't name has none. A 429 (other tabs of the home hold the
// account's waits) asks again after its Retry-After; leaving the page stops it.
export function useTableRuns(loaded: boolean, setTables: Dispatch<SetStateAction<Table[]>>): void {
  useEffect(() => {
    if (!loaded) return
    const stop = new AbortController()
    void (async () => {
      let since: string | null = null
      for (;;) {
        const asked = Date.now()
        let answer
        try { answer = await tablesAPI.runs(since, stop.signal) } catch (e: any) {
          if (stop.signal.aborted) return
          const ms = e?.response?.status === 429
            ? (Number(e.response.headers?.['retry-after']) || RETRY_DEFAULT_SEC) * 1000 : RETRY_AFTER_ERROR_MS
          if (await waitFor(ms, stop.signal)) continue
          return
        }
        if (stop.signal.aborted) return
        since = answer.key
        const byId = new Map(answer.tables.map(r => [r.id, r]))
        setTables(prev => prev.map(t => {
          const runs = byId.get(t.id)
          if (runs) return { ...t, runs }
          if (!t.runs) return t
          const { runs: _gone, ...rest } = t
          return rest
        }))
        const left = MIN_ASK_MS - (Date.now() - asked)
        if (left > 0 && !(await waitFor(left, stop.signal))) return
      }
    })()
    return () => stop.abort()
  }, [loaded, setTables])
}
