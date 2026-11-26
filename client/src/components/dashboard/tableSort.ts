import { useCallback, useState } from 'react'
import type { Table } from '@/utils/api'

export type SortKey = 'name' | 'rows' | 'runs' | 'updated' | 'created'
export interface TableSort { key: SortKey; dir: 'asc' | 'desc' }

// Until a header is clicked: the tables changed most recently first. A header sorts A to Z by name and largest or
// newest first by the others; clicking it again turns it round. Kept in this browser (localStorage) while it works.
export const DEFAULT_SORT: TableSort = { key: 'updated', dir: 'desc' }
const KEY = 'cubex.homeSort'
const KEYS: SortKey[] = ['name', 'rows', 'runs', 'updated', 'created']

const byName = new Intl.Collator('en', { sensitivity: 'base', numeric: true })
const runsOf = (t: Table) => (t.runs?.running ?? 0) + (t.runs?.paused ?? 0)

function compare(a: Table, b: Table, key: SortKey): number {
  if (key === 'name') return byName.compare(a.name, b.name)
  if (key === 'rows') return (a.row_count || 0) - (b.row_count || 0)
  if (key === 'runs') return runsOf(a) - runsOf(b)
  // The server's UTC times ("2026-11-26 10:00:00") sort as text.
  return key === 'updated' ? a.updated_at.localeCompare(b.updated_at) : a.created_at.localeCompare(b.created_at)
}

// Ties go by name, A to Z, whichever way the column runs, so the order never jumps between loads.
export function sortTables(tables: Table[], sort: TableSort): Table[] {
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...tables].sort((a, b) => sign * compare(a, b, sort.key) || byName.compare(a.name, b.name))
}

function remembered(): TableSort {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<TableSort> | null
    if (saved && KEYS.includes(saved.key as SortKey) && (saved.dir === 'asc' || saved.dir === 'desc')) {
      return { key: saved.key as SortKey, dir: saved.dir }
    }
  } catch { /* none kept */ }
  return DEFAULT_SORT
}

export function useTableSort(): [TableSort, (key: SortKey) => void] {
  const [sort, setSort] = useState(remembered)
  const onSort = useCallback((key: SortKey) => setSort(was => {
    const next: TableSort = was.key === key
      ? { key, dir: was.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'name' ? 'asc' : 'desc' }
    try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* sorted, not kept */ }
    return next
  }), [])
  return [sort, onSort]
}
