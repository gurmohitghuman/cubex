import React from 'react'
import { AIColumnModal } from '@/components/AIColumnModal'
import { HTTPAPIColumnModal } from '@/components/HTTPAPIColumnModal'
import { EnrichmentDrawer } from '@/components/EnrichmentDrawer'
import { Sheet, SheetData } from '@/utils/api'
import type { EnrichOpenRequest } from '@/components/enrich-modal/useOpenRequest'

interface SheetRunDrawersProps {
  activeSheet: Sheet | null
  sheetData: SheetData | null
  selectedRowIndices: number[]
  showAddColumnModal: boolean
  showHTTPAPIColumnModal: boolean
  showEnrichmentDrawer: boolean
  enrichOpen: EnrichOpenRequest | null
  clearEnrichOpen: () => void
  enrichWatch: string | null
  stopEnrichWatch: () => void
  setShowAddColumnModal: (b: boolean) => void
  setShowHTTPAPIColumnModal: (b: boolean) => void
  setShowEnrichmentDrawer: (b: boolean) => void
  setSheetData: React.Dispatch<React.SetStateAction<SheetData | null>>
  // Background refresh of the held rows; keeps the viewport (reloadWindow.ts).
  silentReload: (sheetId: string) => Promise<void> | void
  setupSSEConnection: (runId: string, type?: 'ai' | 'http') => void | Promise<void>
  fetchActiveAIRuns: (sheetId: string) => unknown
  fetchActiveHTTPRuns: (sheetId: string) => unknown
}

// The drawers that add filled columns to the sheet: AI Column, Enrichment and
// HTTP API. Split out of SheetModals (200-line guardrail).
export const SheetRunDrawers: React.FC<SheetRunDrawersProps> = ({
  activeSheet, sheetData, selectedRowIndices,
  showAddColumnModal, showHTTPAPIColumnModal, showEnrichmentDrawer, enrichOpen, clearEnrichOpen,
  enrichWatch, stopEnrichWatch,
  setShowAddColumnModal, setShowHTTPAPIColumnModal, setShowEnrichmentDrawer,
  setSheetData, silentReload, setupSSEConnection, fetchActiveAIRuns, fetchActiveHTTPRuns,
}) => {
  if (!activeSheet) return null
  return (
    <>
      <AIColumnModal
        isOpen={showAddColumnModal}
        onClose={() => setShowAddColumnModal(false)}
        sheetId={activeSheet.id}
        rowGeneration={sheetData?.sheet?.row_generation}
        defaultAiModel={sheetData?.sheet?.default_ai_model}
        onDefaultModelChanged={(model) => {
          setSheetData(prev => prev ? { ...prev, sheet: { ...prev.sheet, default_ai_model: model } } : prev)
        }}
        defaultAiConcurrency={sheetData?.sheet?.default_ai_concurrency}
        onDefaultConcurrencyChanged={(concurrency) => {
          setSheetData(prev => prev ? { ...prev, sheet: { ...prev.sheet, default_ai_concurrency: concurrency } } : prev)
        }}
        onSuccess={() => {
          // SILENT reload: the grid stays mounted (no FullPageLoader flash) while
          // it picks up the newly created column + its '⏳ Processing...' cells. The
          // load's side-load chain also runs reconnectToActiveRuns to attach SSE.
          // Matches the menu run actions; a loud reload here flashed the page on create.
          silentReload(activeSheet.id)
          // No success toast — the new column appears in the grid and
          // cells visibly start filling with '⏳ Processing...'.
        }}
        onRunStarted={(runId: string) => {
          setupSSEConnection(runId, 'ai')
          setShowAddColumnModal(false)
          // Refresh active runs so the header Pause/Stop controls appear immediately.
          fetchActiveAIRuns(activeSheet.id)
        }}
      />

      <EnrichmentDrawer
        isOpen={showEnrichmentDrawer}
        onClose={() => { setShowEnrichmentDrawer(false); stopEnrichWatch() }}
        sheetId={activeSheet.id}
        columns={sheetData?.data.columns ?? []}
        loadedRows={sheetData?.data.rows ?? []}
        selectedRows={selectedRowIndices}
        rowGeneration={sheetData?.sheet?.row_generation}
        onRunStarted={(runId: string) => {
          // Follow the run live, and a silent reload shows its new columns
          // (seeding paints ⏳ as it goes). The drawer stays open on the run.
          setupSSEConnection(runId, 'http')
          fetchActiveHTTPRuns(activeSheet.id)
          silentReload(activeSheet.id)
        }}
        onRunChanged={() => {
          fetchActiveHTTPRuns(activeSheet.id)
          silentReload(activeSheet.id)
        }}
        openRequest={enrichOpen}
        onOpenHandled={clearEnrichOpen}
        watchRunId={enrichWatch}
        onStopWatching={stopEnrichWatch}
      />

      <HTTPAPIColumnModal
        isOpen={showHTTPAPIColumnModal}
        onClose={() => setShowHTTPAPIColumnModal(false)}
        sheetId={activeSheet.id}
        rowGeneration={sheetData?.sheet?.row_generation}
        defaultAiModel={sheetData?.sheet?.default_ai_model}
        onSuccess={() => {
          // SILENT reload — see the AI modal above. No page flash on create; the new
          // columns + '⏳ Processing...' cells appear and SSE attaches via the load's
          // reconnectToActiveRuns side-load.
          silentReload(activeSheet.id)
          // No success toast — new columns visible immediately, processing
          // status shows in each cell.
        }}
        onRunStarted={(runId: string) => {
          setupSSEConnection(runId, 'http')
          setShowHTTPAPIColumnModal(false)
        }}
      />
    </>
  )
}
