// Over 200 lines: the sheet's whole toolbar (runs, rows, data and enrich groups) in one bar.
import React from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft, CopyMinus, Import, Loader2, Pause, Play, Square, Trash2,
} from 'lucide-react'
import { CubeLogo } from '@/components/CubeLogo'
import { SaveStatus } from '@/components/SaveStatus'
import { SheetEnrichActions } from './SheetEnrichActions'
import { SheetSetupsMenu } from './SheetSetupsMenu'
import { SheetUsageButton } from './SheetUsageButton'
import { ExportButton, type ExportScope } from '@/components/views/ExportButton'
import { SheetHistoryButton } from './SheetHistoryButton'

interface SheetHeaderProps {
  tableName: string | undefined
  totalRows: number
  // Rows currently loaded in the grid window (< totalRows on a large sheet). Lets
  // the Delete button tell the truth when "select all" only caught the loaded
  // subset — AG Grid Community's header checkbox can't select unloaded rows.
  loadedRowsCount: number
  columnCount: number
  selectedRowCount: number
  isExporting: boolean
  hasRows: boolean
  saveStatus: any
  retrySave: () => void
  anyActiveRuns: boolean
  anyRunning: boolean
  canStopAll: boolean // anything on the sheet is running: a run, or a setup between its steps
  stoppingAll: boolean
  onPauseAll: () => void | Promise<void>
  onResumeAll: () => void | Promise<void>
  onStopAll: () => void | Promise<void>
  onDeleteSelectedRows: () => void
  onImport: () => void
  onExport: (scope: ExportScope, viewName: string) => void
  // The view showing narrows the sheet: Export asks "this view or the whole sheet".
  viewNarrows: boolean
  viewName: string
  onRemoveDuplicates: () => void
  // Auto-dedupe is on: the Remove duplicates button says so.
  autoDedupeOn?: boolean
  onSaveSetup: () => void
  onUseSetup: () => void
  onAddAIColumn: () => void
  onAddEnrichment: () => void
  onAddHTTPColumn: () => void
  onAddWaterfall: () => void
  onOpenWebhook: () => void
  // Auto-run's chip, shown while any column has auto-run on (components/autorun/AutorunChip).
  autorunChip?: React.ReactNode
  // The sheet the Usage button reads (null: none open yet).
  sheetId?: string | null
  sheetName?: string
}

export const SheetHeader: React.FC<SheetHeaderProps> = ({
  tableName,
  totalRows,
  loadedRowsCount,
  columnCount,
  selectedRowCount,
  isExporting,
  hasRows,
  saveStatus,
  retrySave,
  anyActiveRuns,
  anyRunning,
  canStopAll, stoppingAll,
  onPauseAll,
  onResumeAll,
  onStopAll,
  onDeleteSelectedRows,
  onImport,
  onExport, viewNarrows, viewName,
  onRemoveDuplicates, autoDedupeOn,
  onSaveSetup,
  onUseSetup,
  onAddAIColumn,
  onAddEnrichment,
  onAddHTTPColumn,
  onAddWaterfall,
  onOpenWebhook,
  autorunChip,
  sheetId,
  sheetName,
}) => {
  return (
    <header className="bg-white border-b border-gray-200 flex-shrink-0">
      <div className="px-6">
        <div className="flex justify-between items-center h-14">
          <div className="flex items-center space-x-3">
            <Link
              to="/dashboard"
              className={
                'p-2.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded ' +
                'transition-colors duration-200'
              }
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <CubeLogo size="md" className="hidden sm:block" />
            <div>
              <h1 className="font-brand-semibold text-lg text-gray-900 tracking-tight">{tableName}</h1>
              <p className="meta-label">
                {totalRows.toLocaleString()} row{totalRows === 1 ? '' : 's'}
                {' • '}
                {columnCount} column{columnCount === 1 ? '' : 's'}
              </p>
            </div>

            {canStopAll && (
              <div className="flex items-center space-x-1 ml-2">
                {anyActiveRuns && (anyRunning ? (
                  <button
                    onClick={onPauseAll}
                    className="btn-secondary flex items-center space-x-1"
                    title="Pause all runs"
                  >
                    <Pause className="h-3 w-3" />
                    <span>Pause</span>
                  </button>
                ) : (
                  <button
                    onClick={onResumeAll}
                    className="btn-secondary flex items-center space-x-1"
                    title="Resume all runs"
                  >
                    <Play className="h-3 w-3" />
                    <span>Resume</span>
                  </button>
                ))}
                <button onClick={onStopAll} disabled={stoppingAll}
                  className={'btn-danger flex items-center space-x-1 whitespace-nowrap '
                    + 'disabled:opacity-50 disabled:cursor-not-allowed'}
                  title="Stop every run and setup on this sheet">
                  {stoppingAll ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
                  <span>Stop all</span>
                </button>
              </div>
            )}
            {autorunChip}
          </div>

          <div className="flex items-center space-x-2">
            <SaveStatus status={saveStatus} onRetry={retrySave} />
            {selectedRowCount > 0 && (() => {
              // Honest selection: AG Grid Community's "select all" only selects the
              // LOADED window. When the user selected the whole window but more rows
              // exist beyond it, say so — so "Delete" can't be mistaken for "delete
              // everything". (True cross-page select-all is a separate follow-up.)
              // `selectedRowCount <= totalRows` clamps a transient post-delete state:
              // right after deleting the window the selection is briefly stale (still
              // the deleted count) while totalRows already dropped, which would otherwise
              // flash an impossible "Delete (N of fewer-than-N)" before the refill clears it.
              const onlyWindowSelected =
                selectedRowCount >= loadedRowsCount && totalRows > loadedRowsCount && selectedRowCount <= totalRows
              return (
                <button
                  onClick={onDeleteSelectedRows}
                  className="btn-danger flex items-center space-x-1"
                  title={onlyWindowSelected
                    ? `Delete the ${selectedRowCount.toLocaleString()} loaded rows. ` +
                      `${(totalRows - loadedRowsCount).toLocaleString()} more rows aren't loaded and ` +
                      `won't be deleted: scroll to load them first.`
                    : 'Delete selected rows'}
                >
                  <Trash2 className="h-3 w-3" />
                  <span>
                    Delete (
                    {selectedRowCount.toLocaleString()}
                    {onlyWindowSelected ? ` of ${totalRows.toLocaleString()}` : ''}
                    )
                  </span>
                </button>
              )
            })()}

            <div className="flex items-center space-x-1">
              <button onClick={onImport} className="btn-secondary flex items-center space-x-1">
                <Import className="h-3 w-3" />
                <span>Import</span>
              </button>

              <ExportButton isExporting={isExporting} disabled={!hasRows} viewNarrows={viewNarrows}
                viewName={viewName} onExport={scope => onExport(scope, viewName)} />

              <button onClick={onRemoveDuplicates} disabled={columnCount === 0} data-testid="remove-duplicates"
                title={autoDedupeOn ? 'Auto-dedupe is on: new rows with a key already in the sheet go to the trash'
                  : 'Find and remove duplicate rows'}
                className={'btn-secondary relative flex items-center space-x-1 disabled:opacity-50 '
                  + 'disabled:cursor-not-allowed'}>
                <CopyMinus className="h-3 w-3" />
                <span>Remove duplicates</span>
                {/* Auto-dedupe on: a dot on the corner (the toolbar has no room for a label at 1280px). */}
                {autoDedupeOn && (
                  <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-cube-black ring-2 ring-white"
                    data-testid="auto-dedupe-chip"><span className="sr-only">(auto-dedupe on)</span></span>
                )}
              </button>
              <SheetSetupsMenu onUseSetup={onUseSetup} onSaveSetup={onSaveSetup} />
              <SheetUsageButton sheetId={sheetId ?? null} sheetName={sheetName ?? ''} />
              <SheetHistoryButton sheetId={sheetId ?? null} />
            </div>

            {/* Divider between data-management (Import/Export) and the enrich
                group. Gives the enrich actions their own visual cluster so the
                ONE primary (AI Column) reads as the point of the page. */}
            <div className="w-px h-5 bg-gray-200" aria-hidden="true" />

            <SheetEnrichActions hasRows={hasRows} onAddAIColumn={onAddAIColumn} onAddEnrichment={onAddEnrichment}
              onAddHTTPColumn={onAddHTTPColumn} onAddWaterfall={onAddWaterfall} onOpenWebhook={onOpenWebhook} />
          </div>
        </div>
      </div>
    </header>
  )
}
