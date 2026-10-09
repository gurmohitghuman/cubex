import React from 'react'
import { CheckCircle, Loader2, PauseCircle } from 'lucide-react'
import type { EnrichRunStatus } from '@/utils/api'
import { plural } from '@/lib/utils'
import { limitText, spent } from '@/lib/enrich-format'
import { RunResultRows } from './RunResultRows'
import { PausedNotice } from './PausedNotice'
import { runActive, type EnrichRunControls } from './useEnrichRun'

interface Props {
  run: EnrichRunControls
  onViewResults: () => void
  // Once it ends: "Add another enrichment", or "Back" to the draft under a watched run.
  secondaryLabel: string
  onSecondary: () => void
}

const STATUS_WORD: Record<EnrichRunStatus['status'], string> = {
  pending: 'Starting', running: 'Running', paused: 'Paused', completed: 'Done', cancelled: 'Stopped', failed: 'Failed',
}

// A list job: rows added to its sheet, and results still on their way.
function listLine(s: EnrichRunStatus): string | null {
  const l = s.list
  if (!l) return null
  const dest = l.destName ?? 'a sheet that was deleted'
  const parts = l.added > 0 ? [`${plural(l.added, 'row')} added to ${dest}`] : []
  if (l.adding.results > 0) parts.push(`${plural(l.adding.results, 'row')} on the way to ${dest}`)
  if (l.waitingRoom.results > 0) parts.push(`${plural(l.waitingRoom.results, 'row')} wait for room in ${dest}`)
  if (l.waitingFields.results > 0) parts.push(`${plural(l.waitingFields.results, 'result')} wait for fields`)
  if (parts.length === 0) return `No rows added to ${dest} yet.`
  const text = parts.join(', ')
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
}

function headline(s: EnrichRunStatus): string {
  if (s.status === 'pending' && s.totalRows === 0) return 'Getting the rows ready…'
  if (s.status === 'completed') {
    return s.totalRows === 0
      ? 'No rows could run: they are missing an input.' : `Ran ${s.toolName} on ${plural(s.totalRows, 'row')}.`
  }
  if (s.status === 'cancelled') return "The run was stopped. Rows it hadn't reached were left empty."
  if (s.status === 'failed') return `The run stopped: ${s.message ?? 'something went wrong.'}`
  if (s.status === 'paused') return `Paused after ${plural(s.processedRows, 'row')} of ${s.totalRows.toLocaleString()}.`
  return `Running ${s.toolName} on ${plural(s.totalRows, 'row')}…`
}

// Step 4: a full run as it goes. Progress, what it has spent of its limit,
// the newest rows, and, when the run paused itself, the fix in place. Pause,
// Resume and Cancel sit in the drawer's header. The grid fills at the same time.
export const RunStep: React.FC<Props> = ({ run, onViewResults, secondaryLabel, onSecondary }) => {
  const s = run.status
  if (!s) {
    return (
      <div className="p-4 text-sm text-gray-600 flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />{run.loadError ?? 'Loading the run…'}
      </div>
    )
  }
  const active = runActive(s)
  const pct = s.totalRows > 0 ? Math.min(100, (s.processedRows / s.totalRows) * 100) : 0
  const ofLimit = s.spendLimitUsd !== null ? ` of ${limitText(s.spendLimitUsd)}` : ''
  return (
    <div className="p-4 space-y-4" data-testid="enrich-run-step">
      <div className="bg-gray-50 border border-gray-200 p-3 space-y-2">
        <div className="flex items-start gap-2">
          {s.status === 'paused' ? <PauseCircle className="h-4 w-4 text-amber-700 flex-shrink-0 mt-0.5" />
            : active ? <Loader2 className="h-4 w-4 text-cube-black animate-spin flex-shrink-0 mt-0.5" />
              : <CheckCircle className="h-4 w-4 text-cube-black flex-shrink-0 mt-0.5" />}
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-gray-800">Enrichment progress</h4>
            <p className="text-xs text-gray-700 mt-0.5" data-testid="enrich-run-headline">{headline(s)}</p>
          </div>
        </div>
        <div>
          <div className="flex justify-between text-xs text-gray-700 mb-1">
            <span>Progress</span>
            <span data-testid="enrich-run-progress">
              {s.processedRows.toLocaleString()} of {s.totalRows.toLocaleString()}
            </span>
          </div>
          <div className="w-full bg-gray-300 h-1.5" role="progressbar" aria-label="Rows done"
            aria-valuemin={0} aria-valuemax={s.totalRows} aria-valuenow={s.processedRows}>
            <div className="bg-cube-black h-1.5 transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <p className="text-xs text-gray-700" data-testid="enrich-run-spent">
          Status: <span className="font-medium">{STATUS_WORD[s.status]}</span>
          {' · '}{active ? 'Spent so far' : 'Spent'}: {spent(s.spentUsd)}{ofLimit}
          {s.rows.failed > 0 && ` · ${plural(s.rows.failed, 'row')} failed`}
        </p>
        {s.list && <p className="text-xs text-gray-700" data-testid="enrich-run-list">{listLine(s)}</p>}
        {s.skippedRows > 0 && (
          <p className="text-xs text-gray-600">
            {plural(s.skippedRows, 'row')} had an empty input and {s.skippedRows === 1 ? 'was' : 'were'} left out,
            at no cost.
          </p>
        )}
      </div>

      <PausedNotice status={s} run={run} />
      {run.actionError && <p className="text-xs text-red-600">{run.actionError}</p>}

      {s.latest.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-gray-900">Latest results</h4>
          <RunResultRows results={s.latest} statusColumn={s.statusColumn} outputColumns={s.outputColumns} />
        </div>
      )}

      {!active && (
        <div className="flex justify-center gap-2 pt-2">
          <button type="button" onClick={onSecondary} className="btn-secondary">{secondaryLabel}</button>
          <button type="button" onClick={onViewResults} className="btn-primary flex items-center gap-2"
            data-testid="enrich-view-results">
            <CheckCircle className="h-4 w-4" /><span>View results</span>
          </button>
        </div>
      )}
    </div>
  )
}
