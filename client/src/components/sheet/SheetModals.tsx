import React from 'react'
import toast from 'react-hot-toast'
import { INITIAL_ROW_LOAD } from '@/lib/constants'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ScrapedDataModal, type SourcesCell } from '@/components/ScrapedDataModal'
import { ImportCSVModal } from '@/components/sheet/ImportCSVModal'
import { NewColumnModal } from '@/components/sheet/NewColumnModal'
import { SheetRunDrawers } from '@/components/sheet/SheetRunDrawers'
import { Sheet, SheetData } from '@/utils/api'
import { plural } from '@/lib/utils'

interface SheetModalsProps {
  activeSheet: Sheet | null
  sheetData: SheetData | null
  selectedRowIndices: number[]
  // open flags
  confirmTopbarDeleteOpen: boolean
  showImportModal: boolean
  showAddColumnModal: boolean
  showHTTPAPIColumnModal: boolean
  showEnrichmentDrawer: boolean
  showNewColumnModal: boolean
  scrapedDataModal: { isOpen: boolean; cell: SourcesCell | null }
  // setters
  setConfirmTopbarDeleteOpen: (b: boolean) => void
  setShowImportModal: (b: boolean) => void
  setShowAddColumnModal: (b: boolean) => void
  setShowHTTPAPIColumnModal: (b: boolean) => void
  setShowEnrichmentDrawer: (b: boolean) => void
  setShowNewColumnModal: (b: boolean) => void
  setScrapedDataModal: (s: { isOpen: boolean; cell: SourcesCell | null }) => void
  setSelectedRowIndices: (rows: number[]) => void
  // Clears the grid row selection through AG Grid (deselectAll) — un-highlights the
  // rows AND syncs the mirrors. The topbar confirm uses this instead of only
  // clearing the React mirror, which left rows visually selected. No-op if the grid
  // isn't mounted (e.g. empty sheet); the mirror's already empty there anyway.
  clearGridSelection: () => void
  setSheetData: React.Dispatch<React.SetStateAction<SheetData | null>>
  setLoadedRowsCount: (n: number) => void
  // behaviors
  handleDeleteRows: (rows: number[]) => Promise<void> | void
  handleAddColumn: (name: string) => Promise<boolean>
  loadSheetData: (sheetId: string, limit?: number, offset?: number, opts?: { silent?: boolean }) => Promise<void> | void
  // Autosave barrier for CSV-replace import (same as sort/delete/rename).
  waitForSaves: (timeoutMs?: number) => Promise<boolean>
  dropAllPending: (sheetId: string) => void
  setupSSEConnection: (runId: string, type?: 'ai' | 'http') => void | Promise<void>
  fetchActiveAIRuns: (sheetId: string) => unknown
}

export const SheetModals: React.FC<SheetModalsProps> = (props) => {
  const {
    activeSheet, sheetData, selectedRowIndices,
    confirmTopbarDeleteOpen, showImportModal, showAddColumnModal,
    showHTTPAPIColumnModal, showEnrichmentDrawer, showNewColumnModal, scrapedDataModal,
    setConfirmTopbarDeleteOpen, setShowImportModal, setShowAddColumnModal,
    setShowHTTPAPIColumnModal, setShowEnrichmentDrawer, setShowNewColumnModal, setScrapedDataModal,
    setSelectedRowIndices, clearGridSelection, setSheetData, setLoadedRowsCount,
    handleDeleteRows, handleAddColumn, loadSheetData, setupSSEConnection, fetchActiveAIRuns,
    waitForSaves, dropAllPending,
  } = props

  return (
    <>
      <ConfirmDialog
        isOpen={confirmTopbarDeleteOpen}
        title="Delete Rows"
        message={`Are you sure you want to delete ${selectedRowIndices.length} selected row(s)?`}
        confirmText="Delete"
        isDestructive
        onConfirm={() => {
          // selectedRowIndices already holds persistent data row indices
          // (__rowIndex from the grid selection) — no positional re-mapping.
          // Close + clear selection IMMEDIATELY, then run the delete
          // fire-and-forget so the popup never hangs on the round-trip;
          // handleDeleteRows shows its own "Deleting…" toast (see useCellOps).
          const toDelete = Array.from(new Set(selectedRowIndices))
          setConfirmTopbarDeleteOpen(false)
          // clearGridSelection (deselectAll) un-highlights the rows and syncs the
          // mirror via onSelectionChanged; also clear the mirror directly so the
          // topbar count drops instantly regardless of AG Grid's event timing.
          setSelectedRowIndices([])
          clearGridSelection()
          if (toDelete.length > 0) void handleDeleteRows(toDelete)
        }}
        onCancel={() => setConfirmTopbarDeleteOpen(false)}
      />

      <ImportCSVModal
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        sheetId={activeSheet?.id}
        onBeforeImport={async () => {
          if (!activeSheet) return true
          // Flush in-flight saves (can't be recalled — let them land first), then
          // discard ALL pending edits for this sheet: a CSV-replace rewrites
          // row_index for new rows + bumps row_generation, so any straggler edit
          // would otherwise flush onto the wrong row after reload. On a flush
          // timeout, abort the import (return false) rather than risk that.
          const flushed = await waitForSaves(5000)
          if (!flushed) return false
          dropAllPending(activeSheet.id)
          return true
        }}
        onImported={async ({ rowsImported, newColumns }) => {
          if (!activeSheet) return
          // Did the sheet already have data BEFORE this import? (Capture before
          // the reload replaces sheetData.) New columns only land off-screen to
          // the right when appending onto existing columns. On a brand-new or
          // empty sheet they're the only columns and start in view, so the
          // "new columns" hint would be noise there.
          const sheetHadData = (sheetData?.data.rows.length ?? 0) > 0
          setLoadedRowsCount(0)
          await loadSheetData(activeSheet.id, INITIAL_ROW_LOAD, 0)
          if (sheetHadData && newColumns.length > 0) {
            const noun = newColumns.length === 1 ? 'column' : 'columns'
            toast.success(`Imported ${plural(rowsImported, 'row')} in ${newColumns.length} new ${noun}. Scroll right to view.`)
          } else {
            toast.success(`${plural(rowsImported, 'row')} imported`)
          }
        }}
      />

      <SheetRunDrawers
        activeSheet={activeSheet} sheetData={sheetData} selectedRowCount={selectedRowIndices.length}
        showAddColumnModal={showAddColumnModal} showHTTPAPIColumnModal={showHTTPAPIColumnModal}
        showEnrichmentDrawer={showEnrichmentDrawer}
        setShowAddColumnModal={setShowAddColumnModal} setShowHTTPAPIColumnModal={setShowHTTPAPIColumnModal}
        setShowEnrichmentDrawer={setShowEnrichmentDrawer}
        setSheetData={setSheetData} loadSheetData={loadSheetData}
        setupSSEConnection={setupSSEConnection} fetchActiveAIRuns={fetchActiveAIRuns}
      />

      <NewColumnModal
        isOpen={showNewColumnModal}
        onClose={() => setShowNewColumnModal(false)}
        onSubmit={async (name) => {
          // On an empty sheet the server also creates the first row; reload so
          // the grid replaces the empty state with a cell to type into.
          const wasEmpty = (sheetData?.data.totalRows ?? 0) === 0
          const added = await handleAddColumn(name)
          if (added && wasEmpty && activeSheet) await loadSheetData(activeSheet.id, INITIAL_ROW_LOAD, 0, { silent: true })
          return added
        }}
      />

      <ScrapedDataModal
        isOpen={scrapedDataModal.isOpen}
        cell={scrapedDataModal.cell}
        onClose={() => setScrapedDataModal({ isOpen: false, cell: null })}
      />
    </>
  )
}
