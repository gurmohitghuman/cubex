import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { tablesAPI, type Table } from '@/utils/api'
import { waitFor } from '@/lib/wait'

// A slot is free by then when the answer didn't say (the server holds a count wait up to 20 s).
const RETRY_DEFAULT_SEC = 20

// The home's tables whose rows were still being counted when the list loaded (row_count_updating): their new
// counts, from GET /api/tables/row-counts, which the server answers once they are made. It holds the request up to
// 20 s, so the home asks again only while a count is still being made after that. Leaving the page stops it. A 429
// (the account already holds its waits: other tabs of the home) shows the counts plainly, no longer as updating,
// and asks again after the answer's Retry-After, by when one of those waits has answered. Any other error stops it
// with the counts shown no longer marked. Answers whether the counts are shown plainly while it waits for a slot.
export function useTableRowCounts(tables: Table[], setTables: Dispatch<SetStateAction<Table[]>>): boolean {
  const waiting = tables.some(t => t.row_count_updating)
  const [refused, setRefused] = useState(false)
  useEffect(() => {
    if (!waiting) return
    const stop = new AbortController()
    void (async () => {
      for (;;) {
        let counts
        try { counts = await tablesAPI.rowCounts(stop.signal) } catch (e: any) {
          if (stop.signal.aborted) return
          if (e?.response?.status === 429) {
            setRefused(true)
            const after = Number(e.response.headers?.['retry-after']) || RETRY_DEFAULT_SEC
            if (await waitFor(after * 1000, stop.signal)) continue
            return
          }
          setTables(prev => prev.map(t => ({ ...t, row_count_updating: false })))
          return
        }
        if (stop.signal.aborted) return
        setRefused(false)
        const byId = new Map(counts.map(c => [c.id, c]))
        setTables(prev => prev.map(t => {
          const c = byId.get(t.id)
          return c ? { ...t, row_count: c.row_count, row_count_updating: c.row_count_updating } : t
        }))
        if (!counts.some(c => c.row_count_updating)) return
      }
    })()
    // A wait that ends while it waits out a 429 isn't refused any more: the next one starts with the spinner.
    return () => { stop.abort(); setRefused(false) }
  }, [waiting, setTables])
  return refused && waiting
}
