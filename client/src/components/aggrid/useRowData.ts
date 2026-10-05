import { useMemo, useRef } from 'react'
import type { AGGridSpreadsheetProps } from './types'

// AG Grid row objects, cached by source-row identity (perf fix #1). The SSE
// buffer and the cell-edit path both replace ONLY changed rows immutably (new
// ref) and keep untouched rows by reference — so an untouched row hits this cache
// and AG Grid sees the SAME rowData object across flushes, re-rendering only the
// rows that actually changed. Without the cache, data.map() minted a fresh object
// for every row on every state update, defeating getRowId's per-row diff.
export function useRowData(data: AGGridSpreadsheetProps['data']) {
  const rowObjectCache = useRef(new WeakMap<object, any>())
  return useMemo(() =>
    data.map(row => {
      const cached = rowObjectCache.current.get(row)
      if (cached) return cached
      const rendered = { __rowIndex: row.rowIndex, ...row.data }
      rowObjectCache.current.set(row, rendered)
      return rendered
    }),
  [data])
}
