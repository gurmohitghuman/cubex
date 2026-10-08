import type React from 'react'
import type { SheetData } from '@/utils/api'
import {
  INITIAL_ROW_LOAD, SILENT_RELOAD_MAX_ROWS, SILENT_RELOAD_PAGE_ROWS, SILENT_RELOAD_LEAD_ROWS,
  SILENT_RELOAD_BELOW_ROWS,
} from '../../lib/constants'

// Background ("silent") reloads refresh the rows the tab holds WITHOUT moving
// the viewport. The tab holds ordinals 0..loaded-1 (the first page plus every
// scroll-end page). A refresh used to refetch only the first 1,000 of them and
// replace the window, so a user scrolled past row 1,000 saw their rows vanish
// and the grid snap back to ~row 980 (every ~15 s while a run filled the sheet).
//
// Now a refresh refetches FROM THE TOP through the viewport, in pages, and
// replaces the window — so every held row is fresh and ordinals stay exact (the
// scroll-end page offset is an ordinal). Only a viewport deeper than
// SILENT_RELOAD_MAX_ROWS allows refetches a slice around it and merges it in.

// keepTail: the plan covers the WHOLE held window, so any rows held beyond it at
// commit time were paged in by a scroll-end load that landed mid-reload (the
// user is looking at them): keep those instead of cutting them off.
export interface ReloadWindow { offset: number; limit: number; keepTail: boolean }

// Which rows to refetch: the whole held window when it fits; else from the top
// through the viewport (held rows further down are dropped and page back in on
// scroll); else, for a very deep viewport, a slice around it.
export function planWindowReload(loaded: number, firstRendered: number | null): ReloadWindow {
  const want = Math.max(INITIAL_ROW_LOAD, loaded)
  if (want <= SILENT_RELOAD_MAX_ROWS) return { offset: 0, limit: want, keepTail: true }
  const first = Math.max(0, firstRendered ?? 0)
  if (first + SILENT_RELOAD_BELOW_ROWS <= SILENT_RELOAD_MAX_ROWS) {
    return { offset: 0, limit: SILENT_RELOAD_MAX_ROWS, keepTail: false }
  }
  const offset = Math.min(Math.max(0, first - SILENT_RELOAD_LEAD_ROWS), loaded - SILENT_RELOAD_MAX_ROWS)
  return { offset, limit: SILENT_RELOAD_MAX_ROWS, keepTail: false }
}

type GetData = (sheetId: string, limit: number, offset: number) => Promise<SheetData>

// Fetch `limit` rows from `offset` in server-sized pages (the GET caps a page at
// SILENT_RELOAD_PAGE_ROWS). Pages are separate reads, so a delete or a sort
// landing between them would shift ordinals and leave a gap: every page must
// carry the same data_version and row_generation, or the result is discarded
// (null) — that change also moved data_version, so the change poll reloads again.
export async function fetchWindow(
  getData: GetData, sheetId: string, offset: number, limit: number,
): Promise<SheetData | null> {
  let first: SheetData | null = null
  const rows: SheetData['data']['rows'] = []
  for (let at = offset; at < offset + limit; at += SILENT_RELOAD_PAGE_ROWS) {
    const want = Math.min(SILENT_RELOAD_PAGE_ROWS, offset + limit - at)
    const page = await getData(sheetId, want, at)
    if (first && (page.sheet.data_version !== first.sheet.data_version
      || page.sheet.row_generation !== first.sheet.row_generation)) return null
    first ??= page
    rows.push(...page.data.rows)
    if (page.data.rows.length < want) break // reached the end of the sheet
  }
  return first && { ...first, data: { ...first.data, rows } }
}

const filtersOf = (d: SheetData) => `${d.sheet.empty_filter ?? ''}\u0000${d.sheet.column_filters ?? ''}`

const sameView = (prev: SheetData | null, fresh: SheetData): prev is SheetData =>
  !!prev && prev.sheet.id === fresh.sheet.id && filtersOf(prev) === filtersOf(fresh)

// Place a reloaded window into `prev`.
//  - From the top (offset 0): a replace, except with `keepTail` (the plan covered
//    the whole held window) a full result keeps held rows past it — they came
//    from a scroll-end page that landed during the reload's fetches.
//  - A deep slice (offset > 0): held rows above it stay, rows below it are
//    dropped (they page back in fresh on scroll). That only fits when nothing
//    re-meant the ordinals above it: same sheet and filters, no column gone
//    (renamed/deleted elsewhere), and the slice starts at the row we hold at
//    that ordinal (a delete above shifts it). Otherwise hand back an empty
//    window: useRowWindowRefill then loud-reloads from the top. Known limit:
//    held rows above a deep slice keep their values until a reload from the top.
export function mergeReloadedWindow(
  prev: SheetData | null, fresh: SheetData, plan: ReloadWindow,
): SheetData {
  const rows = fresh.data.rows
  const withRows = (kept: SheetData['data']['rows']) => ({ ...fresh, data: { ...fresh.data, rows: kept } })
  if (plan.offset === 0) {
    if (!plan.keepTail || !sameView(prev, fresh) || rows.length !== plan.limit || rows.length === 0) return fresh
    const last = rows[rows.length - 1].rowIndex
    const tail = prev.data.rows.slice(plan.limit).filter(r => r.rowIndex > last)
    return tail.length ? withRows([...rows, ...tail]) : fresh
  }
  const freshCols = new Set(fresh.data.columns)
  const fits = sameView(prev, fresh) && prev.data.columns.every(c => freshCols.has(c))
    && rows.length > 0 && prev.data.rows[plan.offset]?.rowIndex === rows[0].rowIndex
  return withRows(fits ? [...prev.data.rows.slice(0, plan.offset), ...rows] : [])
}

// Commit a merged reload. loadedRowsCount (the scroll-end page offset) must equal
// the merged window's length: computed inside the setSheetData updater and read
// from the setLoadedRowsCount updater — both queued here on the same component,
// so React runs them in order (same pattern and rationale as useRowOps' delete).
export function commitMergedWindow(
  setSheetData: React.Dispatch<React.SetStateAction<SheetData | null>>,
  setLoadedRowsCount: React.Dispatch<React.SetStateAction<number>>,
  fresh: SheetData, plan: ReloadWindow,
): void {
  let mergedCount: number | null = null
  setSheetData(prev => {
    const next = mergeReloadedWindow(prev, fresh, plan)
    mergedCount = next.data.rows.length
    return next
  })
  setLoadedRowsCount(prev => mergedCount ?? prev)
}
