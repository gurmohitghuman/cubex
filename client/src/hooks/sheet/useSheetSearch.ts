// Over 200 lines: one search state (typing, steps, counts, jumps); its guards read together.
import { useCallback, useEffect, useRef, useState } from 'react'
import { searchAPI, type SearchMatch, type SheetData } from '@/utils/api'
import { SEARCH_DEBOUNCE_MS, SEARCH_JUMP_LEAD_ROWS, SEARCH_JUMP_ROWS } from '@/lib/constants'
import type { useGridHandles } from './useGridHandles'

// Search in the sheet (the box in the bar above the grid; "/" or Cmd/Ctrl+F
// on the grid opens it). Typing finds the first match at or after the focused
// cell (or from the top), then Enter / Shift+Enter go to the next / previous
// one, wrapping round. The server walks the sheet through the active view
// (routes/sheets-search.ts): the grid holds only a window of rows, so a match
// outside it loads a window around it. "3 of 1,240" comes from a count that
// stops at 10,000 ("10,000+"), asked once per text (again only if the user
// moved before it answered).
export interface SearchStatus {
  phase: 'idle' | 'searching' | 'none' | 'found' | 'error'
  ordinal: number | null
  total: number | null
  capped: boolean
}
const IDLE: SearchStatus = { phase: 'idle', ordinal: null, total: null, capped: false }
type Versions = { data_version: number; row_generation: number }
// position: the cell's row's place in the view, read at `versions`.
type Anchor = { row: number; column: string; position: number; versions: Versions }

const isCancel = (e: unknown) => (e as { code?: string })?.code === 'ERR_CANCELED'
const same = (a?: SearchMatch, b?: SearchMatch) => !!a && !!b && a.row === b.row && a.column === b.column

export function useSheetSearch(args: {
  sheetData: SheetData | null
  viewId: string | null
  grid: ReturnType<typeof useGridHandles>
  loadWindowAt: (sheetId: string, offset: number, limit: number) => Promise<boolean>
}) {
  const { sheetData, viewId, loadWindowAt } = args
  // The grid's handles are stable callbacks (the object holding them isn't).
  const { search: gridSearch, setOpenSearch } = args.grid
  const [query, setQueryState] = useState('')
  const [status, setStatus] = useState<SearchStatus>(IDLE)
  const inputRef = useRef<HTMLInputElement>(null)
  const queryRef = useRef('')
  const current = useRef<{ match: SearchMatch; versions: Versions } | null>(null)
  const anchor = useRef<Anchor | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A find is replaced by the next one; a count only by new text.
  const finding = useRef<AbortController | null>(null)
  const counting = useRef<AbortController | null>(null)
  // A next/previous step on its way, and presses that came meanwhile (+1 next, -1 previous).
  const stepping = useRef(false)
  const queued = useRef(0)
  const live = useRef({ sheetData, viewId })
  live.current = { sheetData, viewId }

  const forget = useCallback(() => {
    queued.current = 0
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    finding.current?.abort()
    counting.current?.abort()
    finding.current = counting.current = null
    current.current = null
    gridSearch()?.show(null)
  }, [gridSearch])

  // Show a match: in the held rows if it is there, else load a window around
  // it; once more if a background reload took that load's place.
  const reveal = useCallback(async (match: SearchMatch) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = live.current.sheetData?.sheet.id
      if (!id || !same(current.current?.match, match)) return
      if (gridSearch()?.show({ rowIndex: match.row, column: match.column })) return
      if (await loadWindowAt(id, Math.max(0, match.position - SEARCH_JUMP_LEAD_ROWS), SEARCH_JUMP_ROWS)) return
      await new Promise(resolve => setTimeout(resolve, SEARCH_DEBOUNCE_MS))
    }
  }, [gridSearch, loadWindowAt])

  // How many cells match and how many come before the current one; asked
  // again when the user moved on before it answered.
  const count = useCallback(async (q: string, at: SearchMatch) => {
    const id = live.current.sheetData?.sheet.id
    if (!id) return
    const ctrl = new AbortController()
    counting.current = ctrl
    try {
      const n = await searchAPI.count(id, q, { at, viewId: live.current.viewId, signal: ctrl.signal })
      if (ctrl.signal.aborted) return
      const now = current.current?.match
      setStatus(s => ({ ...s, total: n.total, capped: n.capped,
        ordinal: same(now, at) ? (n.before !== null ? n.before + 1 : null) : s.ordinal }))
      if (now && !same(now, at)) void count(q, now)
    } catch (e) {
      if (!isCancel(e) && !ctrl.signal.aborted) setStatus(s => ({ ...s, total: null }))
    }
  }, [])

  const run = useCallback(async (mode: 'type' | 'next' | 'prev'): Promise<void> => {
    const data = live.current.sheetData, q = queryRef.current
    if (!data || !q.trim()) return
    const was = current.current
    if (mode !== 'type' && !was) return run('type')
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    finding.current?.abort()
    if (mode === 'type') counting.current?.abort()
    const ctrl = new AbortController()
    finding.current = ctrl
    const held = { data_version: data.sheet.data_version ?? 0, row_generation: data.sheet.row_generation ?? 0 }
    setStatus(s => ({ ...s, phase: 'searching', ...(mode === 'type' ? { ordinal: null, total: null } : {}) }))
    try {
      const a = anchor.current
      const found = await searchAPI.find(data.sheet.id, q, {
        from: mode === 'type' ? (a ? { row: a.row, column: a.column, position: a.position } : undefined) : was!.match,
        versions: mode === 'type' ? a?.versions ?? held : was!.versions,
        inclusive: mode === 'type', back: mode === 'prev', viewId: live.current.viewId, signal: ctrl.signal,
      })
      if (ctrl.signal.aborted) return
      if (!found.match) {
        current.current = null
        gridSearch()?.show(null)
        setStatus({ ...IDLE, phase: 'none', total: 0 })
        return
      }
      current.current = { match: found.match, versions: found }
      setStatus(s => {
        if (mode === 'type') return { ...s, phase: 'found' }
        const knownTotal = s.total !== null && !s.capped ? s.total : null
        const ordinal = mode === 'next'
          ? (found.wrapped ? 1 : s.ordinal !== null ? s.ordinal + 1 : null)
          : (found.wrapped ? knownTotal : s.ordinal !== null ? Math.max(1, s.ordinal - 1) : null)
        return { ...s, phase: 'found', ordinal }
      })
      void reveal(found.match)
      if (mode === 'type') void count(q, found.match)
    } catch (e) {
      if (!isCancel(e) && !ctrl.signal.aborted) setStatus({ ...IDLE, phase: 'error' })
    }
  }, [gridSearch, reveal, count])

  const setQuery = useCallback((text: string) => {
    setQueryState(text)
    queryRef.current = text
    forget()
    if (!text.trim()) { setStatus(IDLE); return }
    setStatus(s => ({ ...s, phase: 'searching' }))
    timer.current = setTimeout(() => { timer.current = null; void run('type') }, SEARCH_DEBOUNCE_MS)
  }, [forget, run])

  // Enter right after typing searches at once instead of waiting for the pause.
  // Presses while a step is on its way are kept and taken in turn.
  const step = useCallback((dir: 1 | -1) => {
    if (timer.current || !current.current) { queued.current = 0; void run('type'); return }
    // Held down, Enter repeats: a few presses wait, not every one.
    if (stepping.current) { queued.current = Math.max(-3, Math.min(3, queued.current + dir)); return }
    stepping.current = true
    void run(dir > 0 ? 'next' : 'prev').finally(() => {
      stepping.current = false
      const d = Math.sign(queued.current) as -1 | 0 | 1
      if (d && current.current) { queued.current -= d; step(d) } else queued.current = 0
    })
  }, [run])
  const next = useCallback(() => step(1), [step])
  const prev = useCallback(() => step(-1), [step])

  const clear = useCallback(() => {
    forget()
    setQueryState('')
    queryRef.current = ''
    setStatus(IDLE)
    inputRef.current?.blur()
  }, [forget])

  // A new search starts at the focused cell (if any), taken when the box gets focus.
  const takeAnchor = useCallback(() => {
    if (current.current) return
    const f = gridSearch()?.focused(), sheet = live.current.sheetData?.sheet
    anchor.current = f && sheet ? { row: f.rowIndex, column: f.column, position: f.position,
      versions: { data_version: sheet.data_version ?? 0, row_generation: sheet.row_generation ?? 0 } } : null
  }, [gridSearch])
  const open = useCallback(() => {
    takeAnchor()
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [takeAnchor])
  useEffect(() => { setOpenSearch(open); return () => setOpenSearch(null) }, [setOpenSearch, open])

  // Another sheet clears the search. A sort, another view or a changed filter:
  // the match may not be the same cell or place, so the text searches again from the top.
  const sheetId = sheetData?.sheet.id ?? null
  const rowGeneration = sheetData?.sheet.row_generation
  const filters = sheetData
    ? [sheetData.sheet.empty_filter, sheetData.sheet.column_filters, sheetData.sheet.row_filter].join('\u0000') : ''
  useEffect(() => {
    forget()
    anchor.current = null
    setQueryState('')
    queryRef.current = ''
    setStatus(IDLE)
  }, [sheetId, forget])
  useEffect(() => {
    if (!current.current && !timer.current) return
    forget()
    anchor.current = null
    if (queryRef.current.trim()) void run('type')
  }, [rowGeneration, viewId, filters]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => forget(), [forget])

  return { inputRef, query, setQuery, next, prev, clear, open, takeAnchor, status }
}

export type SheetSearch = ReturnType<typeof useSheetSearch>
