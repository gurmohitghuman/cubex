// Over 200 lines: the page wires the sheet's hooks to each other (state, loads, saves, runs) as one piece.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ColumnFilters } from '@/lib/filters'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Sheet, SheetData, Table } from '@/utils/api'

import { SheetGridArea } from '@/components/sheet/SheetGridArea'
import { SheetSetupDialogs } from '@/components/setups/SheetSetupDialogs'
import { SetupRunChip } from '@/components/setups/SetupRunChip'
import { SheetHeader } from '@/components/sheet/SheetHeader'
import { SheetTabsBar } from '@/components/sheet/SheetTabsBar'
import { DeleteSheetConfirm } from '@/components/sheet/DeleteSheetConfirm'
import { useSheetOps } from '@/hooks/sheet/useSheetOps'
import { SheetModals } from '@/components/sheet/SheetModals'
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
import { useEnrichPauseToast } from '@/hooks/sheet/useEnrichPauseToast'
import { useSheetView } from '@/hooks/sheet/useSheetView'
import { useSheetViews } from '@/hooks/sheet/useSheetViews'
import { useSheetSearch } from '@/hooks/sheet/useSheetSearch'
import { SheetViewBar } from '@/components/views/SheetViewBar'
import { activeViewOf, rowFilterOf, viewNarrows } from '@/lib/views'
import { gridAreaMode } from '@/hooks/sheet/gridAreaMode'
import { useAutorun } from '@/hooks/sheet/useAutorun'
import { useTableRouting } from '@/hooks/sheet/useTableRouting'
import { useFollowRuns } from '@/hooks/sheet/useFollowRuns'
import { AutorunChip } from '@/components/autorun/AutorunChip'
import { AutorunDialogHost } from '@/components/autorun/AutorunDialogHost'

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
  const [columnFilters, setColumnFilters] = useState<ColumnFilters>({})
  const currentSheetIdRef = useRef<string | null>(null)
  // Forward reference so hooks above loadSheetData can still trigger reloads.
  const loadSheetDataRef = useRef<
    (sheetId: string, limit?: number, offset?: number, opts?: { silent?: boolean }) => Promise<void> | void
  >(() => {})
  // Silent variant for BACKGROUND refreshes (run completion, Stop): no isLoading
  // flip (the FullPageLoader swap unmounts the grid — scroll/selection/edits lost).
  // Refreshes the held rows around the viewport without moving it (reloadWindow.ts).
  const silentReloadRef = useRef<(sheetId: string) => Promise<void> | void>(() => {})
  // A background reload that landed after the held window moved: plan it again.
  const onWindowMoved = useCallback((id: string) => { void silentReloadRef.current(id) }, [])

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

  // Saved views (filters + hidden columns). Its save chain is the filter hooks' too.
  const views = useSheetViews({ activeSheet, sheetData, setSheetData, reloadActiveSheet })
  const filterSaves = { chainRef: views.saveChain, viewId: views.active?.id ?? null }

  // Serializes rapid empty-filter toggles so last-intent (not last-response) wins.
  const onEmptyFilterChange = useEmptyFilter({
    activeSheet, emptyFilter, setEmptyFilter, reloadActiveSheet, ...filterSaves,
  })

  // Per-column "text contains" filter (same server-side + last-intent pattern).
  const onColumnFilterChange = useColumnFilters({
    activeSheet, columnFilters, setColumnFilters, reloadActiveSheet, ...filterSaves,
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

  const onEnrichPaused = useEnrichPauseToast(currentSheetIdRef, modals)
  const sse = useSheetSSE({
    activeSheet, setSheetData, setIsLoading,
    setActiveAIRunsList: runs.setAiRuns,
    setActiveHTTPRuns: runs.setHttpRuns,
    fetchActiveHTTPRuns: runs.fetchHTTPRuns,
    fetchActiveAIRuns: runs.fetchAIRuns,
    // Run-completion refresh is SILENT — the grid stays mounted (scroll,
    // selection, in-progress edits survive); the new cell values just appear.
    reloadSheet: (sheetId) => silentReloadRef.current(sheetId),
    currentSheetIdRef, onEnrichPaused,
  })

  const {
    loadSheetData, loadWindowAt, loadMoreData, loadEarlierData, invalidateInFlightLoads,
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
    activeSheet, loadedRowsCount, windowStart: sheetData?.data.windowStart ?? 0, onWindowMoved,
  })

  // Keep the forward-references fresh.
  useEffect(() => {
    loadSheetDataRef.current = (id, limit, offset, opts) => loadSheetData(id, limit, offset, opts)
    silentReloadRef.current = (id) => {
      const windowStart = sheetData?.sheet.id === id ? sheetData.data.windowStart ?? 0 : 0
      const { offset, limit, keepTail } = planWindowReload(loadedRowsCount, grid.firstRenderedRow(), windowStart)
      return loadSheetData(id, limit, offset, { silent: true, keepWindow: true, keepTail, windowStart })
    }
  })

  // Search in the sheet: the box above the grid, "/" on the grid.
  const search = useSheetSearch({ sheetData, viewId: views.active?.id ?? null, grid, loadWindowAt })

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
    onActiveRuns: useFollowRuns({
      httpRuns: runs.httpRuns, aiRuns: runs.aiRuns, setupSSEConnection: sse.setupSSEConnection,
      refetchRuns: runs.refetch,
    }),
  })

  // Auto-run: the headers' ⚡, the header chip and the column's dialog (Edit cleaning for a clean
  // column, Edit formula for a formula column, Edit lookup for a lookup column).
  const autorun = useAutorun({ activeSheet, sheetData, silentReload: id => silentReloadRef.current(id),
    openClean: column => modals.openClean({ mode: 'edit', column }),
    openFormula: column => modals.openFormula({ mode: 'formula-edit', column }),
    openLookup: column => modals.openLookup({ mode: 'lookup-edit', column }) })

  // "Create a new table for the webhook" offer (only under the table cap).
  const { onCreateNewTable } = useWebhookNewTable()

  const exporter = useExport(activeSheet, cellOps.waitForSaves)

  // A setup being used on the sheet (its chip shows): Stop all shows for it too.
  const [setupLive, setSetupLive] = useState(false)
  const runControls = useRunControls({
    sheetId: activeSheet?.id ?? null, setupLive,
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

  useTableRouting({
    tableId, urlSheetId, navigate, table, setTable, activeSheet, setActiveSheet, setSheetData, setIsLoading,
    setLoadedRowsCount, currentSheetIdRef, selectSheet: sheetOps.selectSheet,
    clearSelection: () => cellOps.setSelectedRowIndices([]), loadSheetData,
  })

  // Refill the row window when a delete leaves it empty or too short to scroll (see hook).
  useRowWindowRefill(activeSheet, isLoading, sheetData, reloadActiveSheet)

  const totalDisplayedRows = sheetData?.data.totalRows || 0
  // Loader, import empty state, or the grid — rules + rationale in gridAreaMode.
  const gridArea = gridAreaMode(isLoading, totalDisplayedRows, emptyFilter, columnFilters,
    rowFilterOf(sheetData).length > 0)

  return (
    <div className="h-screen bg-gray-50 flex flex-col overflow-hidden">
      <SheetHeader
        tableName={table?.name} totalRows={totalDisplayedRows} loadedRowsCount={sheetData?.data.rows.length ?? 0}
        columnCount={columnOps.columnHeaders.length} selectedRowCount={cellOps.selectedRowIndices.length}
        isExporting={exporter.isExporting} hasRows={!!sheetData?.data.rows.length}
        saveStatus={cellOps.saveStatus} retrySave={cellOps.retrySave}
        anyActiveRuns={runControls.anyActiveRuns} anyRunning={runControls.anyRunning}
        canStopAll={runControls.canStopAll} stoppingAll={runControls.stoppingAll}
        onPauseAll={runControls.pauseAll} onResumeAll={runControls.resumeAll} onStopAll={runControls.stopAll}
        onDeleteSelectedRows={() => modals.setConfirmTopbarDeleteOpen(true)}
        onImport={() => modals.setShowImportModal(true)} onExport={exporter.handleExportCSV}
        viewNarrows={viewNarrows(sheetData, views.hiddenColumns)} viewName={activeViewOf(sheetData)?.name ?? ''}
        onAddAIColumn={() => modals.setShowAddColumnModal(true)}
        onAddEnrichment={() => modals.setShowEnrichmentDrawer(true)}
        onAddHTTPColumn={() => modals.setShowHTTPAPIColumnModal(true)}
        onOpenWebhook={() => modals.setShowWebhookDrawer(true)}
        onRemoveDuplicates={() => modals.setShowDedupeModal(true)}
        onSaveSetup={() => modals.openSaveSetup(null)}
        onUseSetup={() => modals.setShowUseSetup(true)}
        sheetId={activeSheet?.id ?? null} sheetName={activeSheet?.name ?? ''}
        autorunChip={<><AutorunChip autorun={autorun} /><SetupRunChip sheetId={activeSheet?.id ?? null}
          dataVersion={sheetData?.sheet?.data_version} onLiveChange={setSetupLive}
          onProgress={() => { if (activeSheet) void silentReloadRef.current(activeSheet.id) }} /></>}
      />
      <SheetViewBar views={views} sheetData={sheetData} columns={columnOps.columnHeaders} search={search} />
      <SheetGridArea
        gridArea={gridArea} activeSheet={activeSheet} sheetData={sheetData} totalDisplayedRows={totalDisplayedRows}
        emptyFilter={emptyFilter} columnFilters={columnFilters} onEmptyFilterChange={onEmptyFilterChange}
        onColumnFilterChange={onColumnFilterChange} loadMoreData={loadMoreData} loadEarlierData={loadEarlierData}
        columnOps={columnOps} cellOps={cellOps} view={view} views={views} runs={runs} modals={modals} grid={grid}
        autorun={autorun} sse={sse} rowGenerationRef={rowGenerationRef}
        silentReload={(id) => silentReloadRef.current(id)}
        webhookColumn={webhookColumn} onWebhookCell={setWebhookPayloadRow}
      />
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
      <DeleteSheetConfirm sheet={confirmDeleteSheet}
        onConfirm={s => { void sheetOps.deleteSheet(s.id); setConfirmDeleteSheet(null) }}
        onCancel={() => setConfirmDeleteSheet(null)} />
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
        fetchActiveAIRuns={runs.fetchAIRuns} fetchActiveHTTPRuns={runs.fetchHTTPRuns}
        waitForSaves={cellOps.waitForSaves}
        dropAllPending={cellOps.dropAllPending}
      />
      <AutorunDialogHost autorun={autorun} />
      <SheetSetupDialogs sheetId={activeSheet?.id} columns={columnOps.columnHeaders} modals={modals} />
      <SheetWebhookOverlays
        autorunOn={autorun.anyOn}
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
