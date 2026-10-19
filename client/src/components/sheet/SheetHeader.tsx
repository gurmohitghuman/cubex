// Over 200 lines: the sheet's whole toolbar (runs, rows, data and enrich groups) in one bar.
import React from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Loader2, Pause, Play, Square, Trash2 } from 'lucide-react'
import { CubeLogo } from '@/components/CubeLogo'
import { SaveStatus } from '@/components/SaveStatus'
import { SheetEnrichActions } from './SheetEnrichActions'
import { SheetDataMenu, type ExportScope } from './toolbar/SheetDataMenu'
import { SheetMoreMenu } from './toolbar/SheetMoreMenu'

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
  onSetupVersions: () => void
  onAddAIColumn: () => void
  onAddEnrichment: () => void
  onAddHTTPColumn: () => void
  onAddWaterfall: () => void
  onAddClean: () => void
  onAddFormula: () => void
  onAddLookup: () => void
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
  onSetupVersions,
  onAddAIColumn,
  onAddEnrichment,
  onAddHTTPColumn,
  onAddWaterfall,
  onAddClean, onAddFormula, onAddLookup,
  onOpenWebhook,
  autorunChip,
  sheetId,
  sheetName,
}) => {
  return (
    <header className="bg-white border-b border-gray-200 flex-shrink-0">
      <div className="px-6">
        {/* One line at every width: the left side (the name, run controls) gives way and truncates,
            the right side never wraps, and its labels fold into icons on narrow screens. */}
        <div className="flex h-14 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Link
              to="/dashboard"
              className={
                'p-2.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded ' +
                'transition-colors duration-200'
              }
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <CubeLogo size="md" className="hidden shrink-0 sm:block" />
            {/* One line, cut with an ellipsis when long: squeezed, a two-word name used to wrap. */}
            <div className="min-w-0">
              <h1 className="font-brand-semibold text-lg text-gray-900 tracking-tight whitespace-nowrap truncate
                max-w-[28rem]" title={tableName}>{tableName}</h1>
              <p className="meta-label whitespace-nowrap">
                {totalRows.toLocaleString()} row{totalRows === 1 ? '' : 's'}
                {' • '}
                {columnCount} column{columnCount === 1 ? '' : 's'}
              </p>
            </div>

            {canStopAll && (
              <div className="flex shrink-0 items-center gap-1">
                {anyActiveRuns && (anyRunning ? (
                  <button
                    onClick={onPauseAll}
                    className="btn-secondary flex h-8 items-center gap-1"
                    title="Pause all runs" aria-label="Pause"
                  >
                    <Pause className="h-3 w-3" aria-hidden="true" />
                    <span className="hidden lg:inline">Pause</span>
                  </button>
                ) : (
                  <button
                    onClick={onResumeAll}
                    className="btn-secondary flex h-8 items-center gap-1"
                    title="Resume all runs" aria-label="Resume"
                  >
                    <Play className="h-3 w-3" aria-hidden="true" />
                    <span className="hidden lg:inline">Resume</span>
                  </button>
                ))}
                <button onClick={onStopAll} disabled={stoppingAll}
                  className={'btn-danger flex items-center gap-1 '
                    + 'disabled:opacity-50 disabled:cursor-not-allowed'}
                  title="Stop every run and setup on this sheet">
                  {stoppingAll ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
                  <span>Stop all</span>
                </button>
              </div>
            )}
            {autorunChip}
          </div>

          <div className="flex shrink-0 items-center gap-2">
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
                  className="btn-danger flex items-center gap-1"
                  aria-label={`Delete (${selectedRowCount.toLocaleString()}${
                    onlyWindowSelected ? ` of ${totalRows.toLocaleString()}` : ''})`}
                  title={onlyWindowSelected
                    ? `Delete the ${selectedRowCount.toLocaleString()} loaded rows. ` +
                      `${(totalRows - loadedRowsCount).toLocaleString()} more rows aren't loaded and ` +
                      `won't be deleted: scroll to load them first.`
                    : 'Delete selected rows'}
                >
                  <Trash2 className="h-3 w-3" aria-hidden="true" />
                  <span className="hidden md:inline">
                    Delete (
                    {selectedRowCount.toLocaleString()}
                    {onlyWindowSelected ? ` of ${totalRows.toLocaleString()}` : ''}
                    )
                  </span>
                  <span className="md:hidden">{selectedRowCount.toLocaleString()}</span>
                </button>
              )
            })()}

            <SheetDataMenu hasRows={hasRows} columnCount={columnCount} isExporting={isExporting}
              viewNarrows={viewNarrows} viewName={viewName} autoDedupeOn={!!autoDedupeOn} onImport={onImport}
              onExport={scope => onExport(scope, viewName)} onOpenWebhook={onOpenWebhook}
              onRemoveDuplicates={onRemoveDuplicates} />
            <SheetMoreMenu sheetId={sheetId ?? null} sheetName={sheetName ?? ''} onUseSetup={onUseSetup}
              onSaveSetup={onSaveSetup} onSetupVersions={onSetupVersions} />

            {/* The data and setup menus apart from the one primary, AI Column and its column types. */}
            <div className="h-5 w-px bg-gray-200" aria-hidden="true" />

            <SheetEnrichActions hasRows={hasRows} hasColumns={columnCount > 0} onAddAIColumn={onAddAIColumn}
              onAddEnrichment={onAddEnrichment} onAddHTTPColumn={onAddHTTPColumn} onAddWaterfall={onAddWaterfall}
              onAddClean={onAddClean} onAddFormula={onAddFormula} onAddLookup={onAddLookup} />
          </div>
        </div>
      </div>
    </header>
  )
}
