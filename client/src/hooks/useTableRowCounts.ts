import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { tablesAPI, type Table } from '@/utils/api'

// The home's tables whose rows were still being counted when the list loaded (row_count_updating): their new
// counts, from GET /api/tables/row-counts, which the server answers once they are made. It holds the request up to
// 20 s, so the home asks again only while a count is still being made after that. A refusal or an error (or
// leaving the page) stops it: the counts shown stay, no longer marked.
export function useTableRowCounts(tables: Table[], setTables: Dispatch<SetStateAction<Table[]>>): void {
  const waiting = tables.some(t => t.row_count_updating)
  useEffect(() => {
    if (!waiting) return
    const stop = new AbortController()
    void (async () => {
      for (;;) {
        let counts
        try { counts = await tablesAPI.rowCounts(stop.signal) } catch {
          if (!stop.signal.aborted) setTables(prev => prev.map(t => ({ ...t, row_count_updating: false })))
          return
        }
        if (stop.signal.aborted) return
        const byId = new Map(counts.map(c => [c.id, c]))
        setTables(prev => prev.map(t => {
          const c = byId.get(t.id)
          return c ? { ...t, row_count: c.row_count, row_count_updating: c.row_count_updating } : t
        }))
        if (!counts.some(c => c.row_count_updating)) return
      }
    })()
    return () => stop.abort()
  }, [waiting, setTables])
}
