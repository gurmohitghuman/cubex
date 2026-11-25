import React, { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { AgGridReact } from 'ag-grid-react'
import type { GridApi, IRowNode } from 'ag-grid-community'
import { isSearchKey, type GridContext } from './gridOptions'
import type { AGGridSpreadsheetProps, GridSearchTarget } from './types'

// The grid's side of search (hooks/sheet/useSheetSearch.ts): highlight the
// cell found (a cell class read from the grid's context, so no column is
// rebuilt) and scroll it into view, now or once its rows arrive (a jump loads
// a new window). Also keeps the viewport still when the rows above a deep
// window are added on top (loadEarlier): the row first in view stays at the
// same pixel, as a browser's scroll anchoring keeps it (never the first row
// AG Grid renders, up to rowBuffer rows above the view).
const PENDING_MS = 15_000

// The first row the viewport shows (its top may be scrolled past) and how far past: the rows AG Grid renders start
// up to rowBuffer rows above the view.
function firstInView(api: GridApi): { node: IRowNode; offset: number } | null {
  const { top } = api.getVerticalPixelRange()
  for (let i = api.getFirstDisplayedRowIndex(), last = api.getLastDisplayedRowIndex(); i <= last; i++) {
    const node = api.getDisplayedRowAtIndex(i)
    if (node && typeof node.rowTop === 'number' && node.rowTop + (node.rowHeight ?? 0) > top) {
      return { node, offset: top - node.rowTop }
    }
  }
  return null
}

export function useGridSearch(args: {
  gridRef: RefObject<AgGridReact>
  windowStart: number
  data: AGGridSpreadsheetProps['data']
  colIdFor: (name: string) => string
  registerSearch?: AGGridSpreadsheetProps['registerSearch']
  onLoadEarlier?: AGGridSpreadsheetProps['onLoadEarlier']
  onOpenSearch?: () => void
  // The grid's scroll box (.ag-body-viewport), to put the anchored row back at its pixel.
  viewport: () => HTMLElement | null
}) {
  const { gridRef, windowStart, data, colIdFor, registerSearch, onLoadEarlier, onOpenSearch, viewport } = args
  // The grid's context: read by cells (the "#" column, the search highlight)
  // without rebuilding any column.
  const context = useRef<GridContext>({ windowStart: 0, hit: null }).current
  context.windowStart = windowStart
  // A cell to show once its rows arrive; it waits a little while, not for a
  // later scroll to pull the viewport to it.
  const pending = useRef<(GridSearchTarget & { until: number }) | null>(null)
  // The row first in view while earlier rows load above it, and how far the
  // view's top is past that row's top (for a few seconds: a page dropped as
  // stale never arrives).
  const anchor = useRef<{ rowIndex: number; offset: number; firstHeld: number; until: number } | null>(null)
  // AG Grid can call a handler from an earlier render: read rows through a ref.
  const dataRef = useRef(data)
  dataRef.current = data
  const liveApi = (): GridApi | null => {
    const api = gridRef.current?.api
    return api && !api.isDestroyed?.() ? api : null
  }

  const reveal = useCallback((api: GridApi, target: GridSearchTarget): boolean => {
    const node = api.getRowNode(String(target.rowIndex))
    if (!node || node.rowIndex === null) return false
    api.ensureNodeVisible(node, 'middle')
    api.ensureColumnVisible(colIdFor(target.column))
    return true
  }, [colIdFor])

  useEffect(() => {
    if (!registerSearch) return
    registerSearch({
      show: target => {
        anchor.current = null
        const before = context.hit
        context.hit = target
        pending.current = target && { ...target, until: Date.now() + PENDING_MS }
        const api = liveApi()
        if (!api) return false
        const nodes = [before, target].flatMap(t => (t ? [api.getRowNode(String(t.rowIndex))] : []))
          .filter((n): n is IRowNode => !!n)
        if (nodes.length) api.redrawRows({ rowNodes: nodes })
        if (!target || reveal(api, target)) { pending.current = null; return true }
        return false
      },
      focused: () => {
        const api = liveApi()
        const cell = api?.getFocusedCell()
        const field = cell?.column.getColDef().field
        const node = cell ? api!.getDisplayedRowAtIndex(cell.rowIndex) : undefined
        if (!cell || !field || field.startsWith('__') || typeof node?.data?.__rowIndex !== 'number') return null
        return { rowIndex: node.data.__rowIndex, column: field, position: context.windowStart + cell.rowIndex }
      },
      column: name => {
        const api = liveApi()
        if (!api || !api.getColumn(colIdFor(name))) return false
        api.ensureColumnVisible(colIdFor(name), 'start')
        return true
      },
    })
    return () => registerSearch(null)
  }, [registerSearch, context, reveal, colIdFor]) // eslint-disable-line react-hooks/exhaustive-deps

  // Asked when scrolling stops at the window's top. Not while a cell search
  // jumped to is about to be shown (its row is among the rows held now, so
  // the grid shows it once it takes them): a scroll that ended just before the
  // jump is read against the new window's top, and the rows added above would
  // then push the match out of view. A jump whose window failed to load or
  // missed its row holds nothing back.
  const loadEarlier = useCallback(() => {
    const api = liveApi(), rows = dataRef.current, p = pending.current
    if (!api || !onLoadEarlier || context.windowStart <= 0 || rows.length === 0) return
    if (p && p.until >= Date.now() && rows.some(r => r.rowIndex === p.rowIndex)) return
    const top = firstInView(api)
    if (top && typeof top.node.data?.__rowIndex === 'number') {
      anchor.current = { rowIndex: top.node.data.__rowIndex, offset: top.offset, firstHeld: rows[0].rowIndex,
        until: Date.now() + 5000 }
    }
    onLoadEarlier(context.windowStart, rows[0].rowIndex)
  }, [onLoadEarlier, context]) // eslint-disable-line react-hooks/exhaustive-deps


  // After AG Grid takes new rows: rows added above keep the same row on top,
  // and a cell search is waiting for comes into view.
  const onRowDataUpdated = useCallback(() => {
    const api = liveApi()
    if (!api) return
    const a = anchor.current
    if (a && a.until < Date.now()) anchor.current = null
    else if (a && dataRef.current[0]?.rowIndex !== a.firstHeld) {
      anchor.current = null
      const node = api.getRowNode(String(a.rowIndex))
      const box = viewport()
      if (node && typeof node.rowTop === 'number' && box) box.scrollTop = node.rowTop + a.offset
      else if (node?.rowIndex !== null && node?.rowIndex !== undefined) api.ensureIndexVisible(node.rowIndex, 'top')
    }
    const target = pending.current
    if (target && target.until < Date.now()) pending.current = null
    else if (target && reveal(api, target)) {
      pending.current = null
      const node = api.getRowNode(String(target.rowIndex))
      if (node) api.redrawRows({ rowNodes: [node] })
    }
  }, [reveal]) // eslint-disable-line react-hooks/exhaustive-deps


  // "/" or Cmd/Ctrl+F on the grid, not while typing in a cell editor or a menu field.
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement
    const typing = !!t.closest('textarea, select, [contenteditable="true"]')
      || (t instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(t.type))
    if (!onOpenSearch || !isSearchKey(e.nativeEvent) || typing) return
    e.preventDefault()
    onOpenSearch()
  }, [onOpenSearch])

  return { context, loadEarlier, onRowDataUpdated, onKeyDown }
}
