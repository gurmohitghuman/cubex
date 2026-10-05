import React from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft, Bot, Download, Globe, Import, Inbox, Loader2, Pause, Play, Square, Trash2,
} from 'lucide-react'
import { CubeLogo } from '@/components/CubeLogo'
import { SaveStatus } from '@/components/SaveStatus'

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
  onPauseAll: () => void | Promise<void>
  onResumeAll: () => void | Promise<void>
  onStopAll: () => void | Promise<void>
  onDeleteSelectedRows: () => void
  onImport: () => void
  onExport: () => void
  onAddAIColumn: () => void
  onAddHTTPColumn: () => void
  onOpenWebhook: () => void
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
  onPauseAll,
  onResumeAll,
  onStopAll,
  onDeleteSelectedRows,
  onImport,
  onExport,
  onAddAIColumn,
  onAddHTTPColumn,
  onOpenWebhook,
}) => {
  return (
    <header className="bg-white border-b border-gray-200 flex-shrink-0">
      <div className="px-6">
        <div className="flex justify-between items-center h-14">
          <div className="flex items-center space-x-3">
            <Link
              to="/dashboard"
              className="p-2.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors duration-200"
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

            {anyActiveRuns && (
              <div className="flex items-center space-x-1 ml-2">
                {anyRunning ? (
                  <button onClick={onPauseAll} className="btn-secondary flex items-center space-x-1" title="Pause all runs">
                    <Pause className="h-3 w-3" />
                    <span>Pause</span>
                  </button>
                ) : (
                  <button onClick={onResumeAll} className="btn-secondary flex items-center space-x-1" title="Resume all runs">
                    <Play className="h-3 w-3" />
                    <span>Resume</span>
                  </button>
                )}
                <button onClick={onStopAll} className="btn-danger flex items-center space-x-1" title="Stop all runs">
                  <Square className="h-3 w-3" />
                  <span>Stop</span>
                </button>
              </div>
            )}
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
                    ? `Delete the ${selectedRowCount.toLocaleString()} loaded rows. ${(totalRows - loadedRowsCount).toLocaleString()} more rows aren't loaded and won't be deleted — scroll to load them first.`
                    : 'Delete selected rows'}
                >
                  <Trash2 className="h-3 w-3" />
                  <span>
                    Delete ({selectedRowCount.toLocaleString()}{onlyWindowSelected ? ` of ${totalRows.toLocaleString()}` : ''})
                  </span>
                </button>
              )
            })()}

            <div className="flex items-center space-x-1">
              <button onClick={onImport} className="btn-secondary flex items-center space-x-1">
                <Import className="h-3 w-3" />
                <span>Import</span>
              </button>

              <button
                onClick={onExport}
                disabled={isExporting || !hasRows}
                className="btn-secondary flex items-center space-x-1 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isExporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                <span>Export</span>
              </button>
            </div>

            {/* Divider between data-management (Import/Export) and the enrich
                group. Gives the enrich actions their own visual cluster so the
                ONE primary (AI Column) reads as the point of the page. */}
            <div className="w-px h-5 bg-gray-200" aria-hidden="true" />

            {/* Enrich group. AI Column is the SINGLE filled/primary action; HTTP
                API + Webhook are secondary so the hierarchy has one clear hero
                (was three near-identical black buttons). */}
            <div className="flex items-center space-x-1">
              <button
                onClick={onAddAIColumn}
                className="btn-primary flex items-center space-x-1"
                disabled={!hasRows}
                title="AI Column: Preview, configure, and run AI processing with full control"
              >
                <Bot className="h-3 w-3" />
                <span>AI Column</span>
              </button>

              <button
                onClick={onAddHTTPColumn}
                className="btn-secondary flex items-center space-x-1"
                disabled={!hasRows}
                title="HTTP API: Call any REST API per row and map response fields into new columns"
              >
                <Globe className="h-3 w-3" />
                <span>HTTP API</span>
              </button>

              <button
                onClick={onOpenWebhook}
                className="btn-secondary flex items-center space-x-1"
                title="Webhook: receive external events as new rows in this sheet"
              >
                <Inbox className="h-3 w-3" />
                <span>Webhook</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </header>
  )
}
