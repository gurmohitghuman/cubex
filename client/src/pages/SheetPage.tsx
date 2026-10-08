import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Sheet, SheetData, Table, tablesAPI } from '@/utils/api'

import { SheetGrid } from '@/components/sheet/SheetGrid'
import { SheetHeader } from '@/components/sheet/SheetHeader'
import { SheetTabsBar } from '@/components/sheet/SheetTabsBar'
import { SheetEmptyState } from '@/components/sheet/SheetEmptyState'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useSheetOps } from '@/hooks/sheet/useSheetOps'
import { SheetModals } from '@/components/sheet/SheetModals'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { SheetWebhookOverlays } from '@/components/webhook/SheetWebhookOverlays'
import { useLiveSheetUpdates } from '@/hooks/sheet/useLiveSheetUpdates'
import { useExternalSheetSync } from '@/hooks/sheet/useExternalSheetSync'
import { useWebhookNewTable } from '@/hooks/sheet/useWebhookNewTable'
import { useRowWindowRefill } from '@/hooks/sheet/useRowWindowRefill'

import { useActiveRuns } from '@/hooks/sheet/useActiveRuns'
import { useCellOps } from '@/hooks/sheet/useCellOps'
import { useColumnOps } from '@/hooks/sheet/useColumnOps'
import { useEmptyFilter } from '@/hooks/sheet/useEmptyFilter'
import { useColumnFilters } from '@/hooks/sheet/useColumnFilters'
import { useExport } from '@/hooks/sheet/useExport'
import { useRunControls } from '@/hooks/sheet/useRunControls'
import { useSheetLoad } from '@/hooks/sheet/useSheetLoad'
import { planWindowReload } from '@/hooks/sheet/reloadWindow'
import { useGridHandles } from '@/hooks/sheet/useGridHandles'
import { useSheetModals } from '@/hooks/sheet/useSheetModals'
import { useSheetSSE } from '@/hooks/sheet/useSheetSSE'
import { useSheetView } from '@/hooks/sheet/useSheetView'
import { gridAreaMode } from '@/hooks/sheet/gridAreaMode'

export const SheetPage: React.FC = () => {
  const { tableId, sheetId: urlSheetId } = useParams<{ tableId: string; sheetId?: string }>()
  const navigate = useNavigate()
  const [confirmDeleteSheet, setConfirmDeleteSheet] = useState<Sheet | null>(null)

  // Root sheet state — owned here because nearly every hook below mutates it.
  const [table, setTable] = useState<Table | null>(null)
  const [activeSheet, setActiveSheet] = useState<Sheet | null>(null)
  const [sheetData, setSheetData] = useState<SheetData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadedRowsCount, setLoadedRowsCount] = useState(0)
  const [emptyFilter, setEmptyFilter] = useState<Record<string, 'empty' | 'not_empty'>>({})
  const [columnFilters, setColumnFilters] = useState<Record<string, { type: 'contains'; value: string }>>({})
  const currentSheetIdRef = useRef<string | null>(null)
  // Forward reference so hooks above loadSheetData can still trigger reloads.
  const loadSheetDataRef = useRef<
    (sheetId: string, limit?: number, offset?: number, opts?: { silent?: boolean }) => Promise<void> | void
  >(() => {})
  // Silent variant for BACKGROUND refreshes (run completion, Stop): no isLoading
  // flip (the FullPageLoader swap unmounts the grid — scroll/selection/edits lost).
  // Refreshes the held rows around the viewport without moving it (reloadWindow.ts).
  const silentReloadRef = useRef<(sheetId: string) => Promise<void> | void>(() => {})

  // Webhook payload viewer (opened by clicking a read-only webhook marker cell).
  const [webhookPayloadRow, setWebhookPayloadRow] = useState<number | null>(null)

  // Clear-selection + first-rendered-row handles the grid registers (useGridHandles).
  const grid = useGridHandles()

  const runs = useActiveRuns()
  const modals = useSheetModals()

  // Per-sheet row_generation last loaded (sheetId → generation). Sent with writes
  // so the server fences stale-index writes after a sort/replace elsewhere (021).
  const rowGenerationRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    const s = sheetData?.sheet
    if (s?.id != null) rowGenerationRef.current.set(s.id, s.row_generation ?? 0)
  }, [sheetData])

  // Stable (ref-backed) loud reload of the current sheet — the 409 row-generation
  // recovery path; stable identity so dependent cellOps handlers don't churn.
  const reloadActiveSheet = useCallback((opts?: { silent?: boolean }): Promise<void> | void => {
    const id = currentSheetIdRef.current
    if (id) return loadSheetDataRef.current(id, undefined, undefined, opts) as Promise<void> | void
  }, [])

  // Serializes rapid empty-filter toggles so last-intent (not last-response) wins.
  const onEmptyFilterChange = useEmptyFilter({
    activeSheet, emptyFilter, setEmptyFilter, reloadActiveSheet,
  })

  // Per-column "text contains" filter (same server-side + last-intent pattern).
  const onColumnFilterChange = useColumnFilters({
    activeSheet, columnFilters, setColumnFilters, reloadActiveSheet,
  })

  // useCellOps owns the autosave queue + its reconciliation helpers
  // (waitForSaves / dropPendingForColumn / renamePendingColumn). Declared
  // before useColumnOps because column delete/rename now reconcile that queue.
  const cellOps = useCellOps({
    activeSheet, setSheetData, setLoadedRowsCount, emptyFilter,
    rowGenerationRef, reloadActiveSheet,
  })

  // Sheet (tab) CRUD + active-sheet reconciliation. selectSheet is the single funnel
  // for all sheet changes (clicks, create/delete, URL back/forward) — it runs the
  // waitForSaves barrier and syncs the URL.
  const sheetOps = useSheetOps({
    table, setTable, activeSheet, setActiveSheet,
    currentUrlSheetId: urlSheetId ?? null,
    navigateToSheet: (sid) => navigate(`/table/${tableId}/${sid}`, { replace: true }),
    waitForSaves: cellOps.waitForSaves,
    dropAllPending: cellOps.dropAllPending,
    setIsLoading,
    clearSheetData: () => setSheetData(null),
    currentSheetIdRef,
  })

  const columnOps = useColumnOps({
    activeSheet, sheetData, setSheetData, setEmptyFilter, setColumnFilters,
    waitForSaves: cellOps.waitForSaves,
    dropPendingForColumn: cellOps.dropPendingForColumn,
    renamePendingColumn: cellOps.renamePendingColumn,
    setAutosavePaused: cellOps.setAutosavePaused,
  })

  const sse = useSheetSSE({
    activeSheet, setSheetData, setIsLoading,
    setActiveAIRunsList: runs.setAiRuns,
    setActiveHTTPRuns: runs.setHttpRuns,
    fetchActiveHTTPRuns: runs.fetchHTTPRuns,
    fetchActiveAIRuns: runs.fetchAIRuns,
    // Run-completion refresh is SILENT — the grid stays mounted (scroll,
    // selection, in-progress edits survive); the new cell values just appear.
    reloadSheet: (sheetId) => silentReloadRef.current(sheetId),
    currentSheetIdRef,
  })

  const {
    loadSheetData, loadMoreData, invalidateInFlightLoads,
    beginStructuralBarrier, endStructuralBarrier, isStructuralBarrierActive,
  } = useSheetLoad({
    setSheetData, setIsLoading, setLoadedRowsCount,
    setColumnOrder: columnOps.setColumnOrder, setEmptyFilter, setColumnFilters,
    fetchActiveHTTPRuns: runs.fetchHTTPRuns,
    fetchActiveAIRuns: runs.fetchAIRuns,
    reconnectToActiveRuns: sse.reconnectToActiveRuns,
    clearSelection: () => cellOps.setSelectedRowIndices([]),
    pendingEditsRef: cellOps.pendingEditsRef,
    recentlySavedRef: cellOps.recentlySavedRef,
    currentSheetIdRef, rowGenerationRef,
    activeSheet, loadedRowsCount,
  })

  // Keep the forward-references fresh.
  useEffect(() => {
    loadSheetDataRef.current = (id, limit, offset, opts) => loadSheetData(id, limit, offset, opts)
    silentReloadRef.current = (id) => {
      const { offset, limit, keepTail } = planWindowReload(loadedRowsCount, grid.firstRenderedRow())
      return loadSheetData(id, limit, offset, { silent: true, keepWindow: true, keepTail })
    }
  })

  const view = useSheetView({
    activeSheet, sheetData, emptyFilter,
    setScrapedDataModal: modals.setScrapedDataModal,
    reloadSheet: () => loadSheetDataRef.current(activeSheet?.id ?? ''),
    waitForSaves: cellOps.waitForSaves,
    clearSelection: () => cellOps.setSelectedRowIndices([]),
    setIsLoading,
  })

  // The read-only webhook marker column name (if this sheet has a webhook), from
  // the authoritative columnTypes. Drives the cell-click raw-view.
  const webhookColumn = Object.entries(sheetData?.data.columnTypes ?? {})
    .find(([, t]) => t === 'webhook-source')?.[0]

  // Sheets created, renamed or deleted elsewhere (API, MCP, another tab).
  const syncSheetList = useExternalSheetSync({
    table, setTable, activeSheet, setActiveSheet,
    selectSheet: sheetOps.selectSheet, dropAllPending: cellOps.dropAllPending,
    onTableGone: () => { toast.error('This table was deleted somewhere else.'); navigate('/dashboard') },
  })

  // Live-update on EVERY open sheet (webhook appends + /api/v1 writers): loud
  // reload when row_generation moved (behind the waitForSaves barrier), silent
  // when only data_version did — rationale + baseline seeding in useLiveSheetUpdates.
  useLiveSheetUpdates({
    sheet: sheetData?.sheet ?? null, rowGenerationRef, currentSheetIdRef,
    waitForSaves: cellOps.waitForSaves, dropAllPending: cellOps.dropAllPending, reloadActiveSheet,
    silentReload: (id) => silentReloadRef.current(id),
    invalidateInFlightLoads, beginStructuralBarrier, endStructuralBarrier, isStructuralBarrierActive,
    sheetList: { key: table?.sheets_key, onChanged: syncSheetList },
  })

  // "Create a new table for the webhook" offer (only under the table cap).
  const { onCreateNewTable } = useWebhookNewTable()

  const exporter = useExport(activeSheet, cellOps.waitForSaves)

  const runControls = useRunControls({
    aiRuns: runs.aiRuns,
    httpRuns: runs.httpRuns,
    refetch: async () => {
      if (!activeSheet) return
      // Reload cells too — Stop clears '⏳ Processing...' placeholders server-side
      // and the grid must see the new empty values. Silent: yanking the grid
      // behind a loader right after Stop loses scroll position and selection.
      await Promise.all([
        runs.refetch(activeSheet.id),
        silentReloadRef.current(activeSheet.id),
      ])
    },
  })

  // Table load — runs once per tableId. NOTE: this effect re-fires when the user
  // navigates BETWEEN tables (e.g. "create a new table for the webhook" routes to
  // a different /table/:id). The auto-pick-sheet effect below only picks a sheet
  // when `!activeSheet`, so we MUST clear activeSheet (+ its derived state) here —
  // otherwise the old table's sheet stays selected, the new table's sheet is never
  // picked, the sheet-data load never fires, and the page hangs on the loader.
  useEffect(() => {
    if (!tableId) return
    setIsLoading(true)
    setActiveSheet(null)
    setSheetData(null)
    setTable(null)
    tablesAPI.getById(tableId)
      .then(setTable)
      .catch(() => { toast.error('Failed to load table'); navigate('/dashboard') })
  }, [tableId, navigate])

  // Auto-pick a sheet of a freshly-loaded table: the URL's sheet if present + valid,
  // else the first sheet. Only when nothing is active yet (no loop; back/forward on an
  // already-active table is handled by the [urlSheetId] sync effect below).
  useEffect(() => {
    if (!table?.sheets) return
    if (table.sheets.length > 0 && !activeSheet) {
      const fromUrl = urlSheetId ? table.sheets.find(s => s.id === urlSheetId) : undefined
      setActiveSheet(fromUrl ?? table.sheets[0])
    }
    // A table with no sheets never picks an activeSheet, so the activeSheet
    // effect's loadSheetData (the only thing that clears the table-load
    // setIsLoading(true)) never runs — without this the FullPageLoader would
    // hang forever. Not reachable via today's UI (every table is created with a
    // sheet, no per-sheet delete exists), but a safety net for any future
    // sheet-delete / partial-migration path. SheetTabsBar + SheetEmptyState
    // render a sane empty state with activeSheet null.
    else if (table.sheets.length === 0) setIsLoading(false)
  }, [table]) // intentionally not depending on activeSheet — would loop

  // Same-table URL change (browser back/forward, or an external deep-link swap between
  // two sheets of the SAME table). The auto-pick effect above only fires on !activeSheet,
  // so this keeps activeSheet in sync when the URL sheetId changes while a sheet is
  // already active. Always route through selectSheet (never a raw setActiveSheet) so the
  // waitForSaves barrier runs; selectSheet skips its own navigate when the URL already
  // matches, so this can't loop.
  useEffect(() => {
    if (!urlSheetId || !table?.sheets || !activeSheet) return
    if (urlSheetId === activeSheet.id) return
    const target = table.sheets.find(s => s.id === urlSheetId)
    if (target) void sheetOps.selectSheet(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSheetId])

  // When activeSheet changes, kick off its data load.
  useEffect(() => {
    if (!activeSheet) return
    currentSheetIdRef.current = activeSheet.id
    setLoadedRowsCount(0)
    // Clear row selection — it's stored by row_index, which means different
    // logical rows on a different sheet. A loud reload remounts the grid with
    // no selection but fires no selectionChanged, so the stale parent state
    // would otherwise drive the header "Delete (N)" button against the wrong
    // sheet's rows. Same reasoning applies after sort/import (handled there).
    cellOps.setSelectedRowIndices([])
    setIsLoading(true)
    loadSheetData(activeSheet.id)
  }, [activeSheet]) // intentionally not depending on loadSheetData — would re-fire on every render

  // Refill the row window when a delete leaves it empty or too short to scroll (see hook).
  useRowWindowRefill(activeSheet, isLoading, sheetData, reloadActiveSheet)

  const totalDisplayedRows = sheetData?.data.totalRows || 0
  // Loader, import empty state, or the grid — rules + rationale in gridAreaMode.
  const gridArea = gridAreaMode(isLoading, totalDisplayedRows, emptyFilter, columnFilters)

  return (
    <div className="h-screen bg-gray-50 flex flex-col overflow-hidden">
      <SheetHeader
        tableName={table?.name} totalRows={totalDisplayedRows} loadedRowsCount={loadedRowsCount}
        columnCount={columnOps.columnHeaders.length}
        selectedRowCount={cellOps.selectedRowIndices.length}
        isExporting={exporter.isExporting} hasRows={!!sheetData?.data.rows.length}
        saveStatus={cellOps.saveStatus} retrySave={cellOps.retrySave}
        anyActiveRuns={runControls.anyActiveRuns} anyRunning={runControls.anyRunning}
        onPauseAll={runControls.pauseAll} onResumeAll={runControls.resumeAll} onStopAll={runControls.stopAll}
        onDeleteSelectedRows={() => modals.setConfirmTopbarDeleteOpen(true)}
        onImport={() => modals.setShowImportModal(true)} onExport={exporter.handleExportCSV}
        onAddAIColumn={() => modals.setShowAddColumnModal(true)}
        onAddHTTPColumn={() => modals.setShowHTTPAPIColumnModal(true)}
        onOpenWebhook={() => modals.setShowWebhookDrawer(true)}
      />
      <div className="flex-1 overflow-hidden">
        {gridArea === 'loading' ? (
          <LoadingSpinner size="md" message="Loading spreadsheet…" className="h-full" />
        ) : gridArea === 'import' ? (
          <SheetEmptyState onImport={() => modals.setShowImportModal(true)} onAddColumn={() => modals.setShowNewColumnModal(true)} />
        ) : (
          <SheetGrid
            activeSheet={activeSheet} forceUpdate={0}
            columns={columnOps.columnHeaders} rows={view.sortedRows} totalRows={totalDisplayedRows}
            emptyFilter={emptyFilter}
            columnFilters={columnFilters}
            lastRenamedColumn={columnOps.lastRenamedColumn}
            columnTypes={sheetData?.data.columnTypes ?? {}}
            activeHTTPRuns={runs.httpRuns} activeAIRunsList={runs.aiRuns}
            activeHTTPRunsByColumn={runs.httpByColumn} activeAIRunsByColumn={runs.aiByColumn}
            onCellEdit={cellOps.handleOptimizedCellEdit}
            onCellClick={(rowIndex, columnName, value) => {
              // Clicking the read-only webhook marker cell opens the raw payload.
              if (webhookColumn && columnName === webhookColumn) { setWebhookPayloadRow(rowIndex); return }
              view.handleCellClick(rowIndex, columnName, value)
            }}
            onLoadMore={loadMoreData} onSortChange={view.handleSortChange}
            onEmptyFilterChange={onEmptyFilterChange}
            onColumnFilterChange={onColumnFilterChange}
            onSelectedRowsChange={cellOps.setSelectedRowIndices}
            onRenameColumn={columnOps.handleRenameColumn}
            onDeleteColumn={columnOps.handleColumnDelete}
            onDeleteRows={cellOps.handleDeleteRows}
            onColumnReorder={columnOps.handleColumnReorder}
            onAddColumn={() => modals.setShowNewColumnModal(true)}
            registerClearSelection={grid.registerClearSelection} registerViewport={grid.registerViewport}
            setShowAddColumnModal={modals.setShowAddColumnModal}
            setupSSEConnection={sse.setupSSEConnection}
            fetchActiveHTTPRuns={runs.fetchHTTPRuns} fetchActiveAIRuns={runs.fetchAIRuns}
            // Live generation source for the selected-rows rerun fence (P2-5) —
            // the same ref every write path uses, seeded from sheetData on load.
            rowGenerationRef={rowGenerationRef}
            // SILENT reload (no FullPageLoader flash; scroll + selection kept). Its
            // side-load chain still runs reconnectToActiveRuns to (re)attach SSE.
            // Used by the run/rerun/stop menu actions in useSheetGridRunActions.
            reloadSheetData={(id) => silentReloadRef.current(id)}
          />
        )}
      </div>
      {/* Bottom tab bar (Excel/Google-Sheets placement): sits below the grid. */}
      <SheetTabsBar
        sheets={table?.sheets ?? []}
        activeSheet={activeSheet}
        onSelectSheet={sheetOps.selectSheet}
        onAddSheet={sheetOps.createSheet}
        onRenameSheet={sheetOps.renameSheet}
        onDeleteSheet={setConfirmDeleteSheet}
        onReorderSheets={sheetOps.reorderSheets}
        onAddRows={cellOps.handleAddRows}
      />
      <ConfirmDialog
        isOpen={!!confirmDeleteSheet}
        title="Delete Sheet"
        message={`Delete "${confirmDeleteSheet?.name}" and all its data? This cannot be undone.`}
        confirmText="Delete Sheet"
        onConfirm={() => {
          if (confirmDeleteSheet) void sheetOps.deleteSheet(confirmDeleteSheet.id)
          setConfirmDeleteSheet(null)
        }}
        onCancel={() => setConfirmDeleteSheet(null)}
        isDestructive
      />
      <SheetModals
        activeSheet={activeSheet} sheetData={sheetData}
        selectedRowIndices={cellOps.selectedRowIndices}
        {...modals}
        setSelectedRowIndices={cellOps.setSelectedRowIndices}
        clearGridSelection={grid.clearSelection}
        setSheetData={setSheetData} setLoadedRowsCount={setLoadedRowsCount}
        handleDeleteRows={cellOps.handleDeleteRows}
        handleAddColumn={columnOps.handleAddColumn}
        loadSheetData={loadSheetData} silentReload={(id) => silentReloadRef.current(id)}
        setupSSEConnection={sse.setupSSEConnection}
        fetchActiveAIRuns={runs.fetchAIRuns}
        waitForSaves={cellOps.waitForSaves}
        dropAllPending={cellOps.dropAllPending}
      />
      <SheetWebhookOverlays
        drawerOpen={modals.showWebhookDrawer}
        onCloseDrawer={() => modals.setShowWebhookDrawer(false)}
        sheetId={activeSheet?.id ?? null}
        rowCount={totalDisplayedRows}
        onColumnsChanged={() => { if (activeSheet) void silentReloadRef.current(activeSheet.id) }}
        onCreateNewTable={onCreateNewTable}
        payloadRowIndex={webhookPayloadRow}
        onClosePayload={() => setWebhookPayloadRow(null)}
      />
    </div>
  )
}
