import { useCallback, useState } from 'react'
import type { Table } from '@/utils/api'

export type SortKey = 'name' | 'rows' | 'runs' | 'opened' | 'updated' | 'created'
export interface TableSort { key: SortKey; dir: 'asc' | 'desc' }

// The home's tabs: every table, the ones the user opened (Recent), the ones they starred (Favorites).
export type HomeTab = 'all' | 'recent' | 'favorites'
const TABS: HomeTab[] = ['all', 'recent', 'favorites']

// Until a header is clicked: the tables changed most recently first, and on Recent the ones opened most recently
// first. A header sorts A to Z by name and largest or newest first by the others; clicking it again turns it round.
// Recent keeps its own sort apart from the other tabs'. Kept in this browser (localStorage) while it works.
export const DEFAULT_SORT: TableSort = { key: 'updated', dir: 'desc' }
export const RECENT_SORT: TableSort = { key: 'opened', dir: 'desc' }
const SORT_KEY = 'cubex.homeSort'
const RECENT_SORT_KEY = 'cubex.homeSort.recent'
const TAB_KEY = 'cubex.homeTab'
const KEYS: SortKey[] = ['name', 'rows', 'runs', 'opened', 'updated', 'created']

const byName = new Intl.Collator('en', { sensitivity: 'base', numeric: true })
const runsOf = (t: Table) => (t.runs?.running ?? 0) + (t.runs?.paused ?? 0)

function compare(a: Table, b: Table, key: SortKey): number {
  if (key === 'name') return byName.compare(a.name, b.name)
  if (key === 'rows') return (a.row_count || 0) - (b.row_count || 0)
  if (key === 'runs') return runsOf(a) - runsOf(b)
  // The server's UTC times ("2026-11-26 10:00:00") sort as text; a table never opened, as the oldest.
  if (key === 'opened') return (a.last_opened_at ?? '').localeCompare(b.last_opened_at ?? '')
  return key === 'updated' ? a.updated_at.localeCompare(b.updated_at) : a.created_at.localeCompare(b.created_at)
}

// Ties go by name, A to Z, whichever way the column runs, so the order never jumps between loads.
export function sortTables(tables: Table[], sort: TableSort): Table[] {
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...tables].sort((a, b) => sign * compare(a, b, sort.key) || byName.compare(a.name, b.name))
}

function remembered(key: string, fallback: TableSort): TableSort {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<TableSort> | null
    if (saved && KEYS.includes(saved.key as SortKey) && (saved.dir === 'asc' || saved.dir === 'desc')) {
      return { key: saved.key as SortKey, dir: saved.dir }
    }
  } catch { /* none kept */ }
  return fallback
}

// recent: Recent's own sort. The list is mounted again when it changes (DashboardPage keys it), so this reads once.
export function useTableSort(recent = false): [TableSort, (key: SortKey) => void] {
  const [storeKey, fallback] = recent ? [RECENT_SORT_KEY, RECENT_SORT] : [SORT_KEY, DEFAULT_SORT]
  const [sort, setSort] = useState(() => remembered(storeKey, fallback))
  const onSort = useCallback((key: SortKey) => setSort(was => {
    const next: TableSort = was.key === key
      ? { key, dir: was.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'name' ? 'asc' : 'desc' }
    try { localStorage.setItem(storeKey, JSON.stringify(next)) } catch { /* sorted, not kept */ }
    return next
  }), [storeKey])
  return [sort, onSort]
}

// The tab the home shows, All until another is picked; kept in this browser like the sort.
export function useHomeTab(): [HomeTab, (tab: HomeTab) => void] {
  const [tab, setTab] = useState<HomeTab>(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY) as HomeTab | null
      if (saved && TABS.includes(saved)) return saved
    } catch { /* none kept */ }
    return 'all'
  })
  const pick = useCallback((next: HomeTab) => {
    setTab(next)
    try { localStorage.setItem(TAB_KEY, next) } catch { /* shown, not kept */ }
  }, [])
  return [tab, pick]
}

// The tables a tab lists, before the search.
export function tablesOfTab(tables: Table[], tab: HomeTab): Table[] {
  if (tab === 'recent') return tables.filter(t => t.last_opened_at)
  if (tab === 'favorites') return tables.filter(t => t.starred)
  return tables
}
