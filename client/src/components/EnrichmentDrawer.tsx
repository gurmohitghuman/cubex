import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DatabaseZap } from 'lucide-react'
import { settingsAPI } from '@/utils/api'
import { Drawer, DrawerHeader } from './Drawer'
import { LoadingSpinner } from './LoadingSpinner'
import { FindStep } from './enrich-modal/FindStep'
import { SetupStep } from './enrich-modal/SetupStep'
import { TestStep } from './enrich-modal/TestStep'
import { RunStep } from './enrich-modal/RunStep'
import { EnrichHeaderControls } from './enrich-modal/EnrichHeaderControls'
import { pickTool, type EnrichDraft, type EnrichStep } from './enrich-modal/draft'
import { useEnrichmentDraft } from './enrich-modal/useEnrichmentDraft'
import { runActive, useEnrichRun } from './enrich-modal/useEnrichRun'
import { useOpenRequest, type EnrichOpenRequest } from './enrich-modal/useOpenRequest'
import { drawerSubtitle, drawerTitle } from './enrich-modal/drawer-copy'
import { saveDraftAutorun } from './enrich-modal/autorun-save'

interface Props {
  isOpen: boolean
  onClose: () => void
  sheetId: string
  // The sheet's columns (the registry), for inputs, names and conditions.
  columns: string[]
  // The rows the grid has loaded, to tell which columns hold values.
  loadedRows: Array<{ data: Record<string, string> }>
  // Row indexes of the selected rows ("Selected rows" mode).
  selectedRows: number[]
  rowGeneration?: number
  // A run started: the sheet follows it (SSE, reload); the drawer shows it.
  onRunStarted: (runId: string) => void
  // A run control (pause, resume, cancel) changed it: refresh the sheet's runs and cells.
  onRunChanged: () => void
  // From the grid: edit a column's enrichment, or watch a run.
  openRequest: EnrichOpenRequest | null
  onOpenHandled: () => void
  // A run to watch over the draft (View Run, a pause toast's Show), and how to stop.
  watchRunId: string | null
  onStopWatching: () => void
}

// The step on screen: the Test and Run steps follow a run; Set up needs a tool.
function stepOf(d: EnrichDraft): EnrichStep {
  if (d.step === 'test' || d.step === 'run') return d.runId ? d.step : d.card ? 'setup' : 'find'
  return d.card ? d.step : 'find'
}

// "Add enrichment": pick a job (Find), map it to the sheet (Set up), check the
// first rows (Test), then follow the full run (Run). Like the AI Column drawer,
// a narrow right-side panel. Its state is kept per sheet while the page is
// open, so closing and reopening resumes where you were; a finished run starts
// over at Find on the next open.
export const EnrichmentDrawer: React.FC<Props> = (p) => {
  const { isOpen, onClose, sheetId, columns, loadedRows, selectedRows } = p
  const { draft, update, reset } = useEnrichmentDraft(sheetId)
  // Read when Set up builds its defaults; recomputed only while the drawer is open.
  const filledColumns = useMemo(() => {
    if (!isOpen || loadedRows.length === 0) return null
    return new Set(columns.filter(c => loadedRows.some(r => (r.data[c] ?? '').trim() !== '')))
  }, [isOpen, columns, loadedRows])
  // undefined while loading; the key can change in Settings, so read it on each open.
  const [hasKey, setHasKey] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    if (!isOpen) return
    let alive = true
    settingsAPI.get().then(s => { if (alive) setHasKey(!!s.hasTregKey) }).catch(() => {})
    return () => { alive = false }
  }, [isOpen])

  const opening = useOpenRequest(sheetId, p.openRequest, isOpen, update, p.onOpenHandled)
  // Opened from the toolbar after a full run ended while it was open: start
  // over at Find (before paint, so the old run doesn't flash). A run that ended
  // with the drawer closed shows its outcome once; the next open starts over.
  const wasOpen = useRef(false)
  useLayoutEffect(() => {
    const fresh = isOpen && !wasOpen.current && !p.openRequest && !p.watchRunId
    if (fresh && draft.step === 'run' && draft.runEnded) reset()
    wasOpen.current = isOpen
  }, [isOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  // A watched run (View Run, a toast's Show) shows over the draft without
  // changing it. Otherwise the draft's own run is followed in every step, so
  // Set up knows when one is still filling its column.
  const watching = p.watchRunId
  const step: EnrichStep = watching ? 'run' : stepOf(draft)
  const run = useEnrichRun(watching ?? draft.runId, isOpen, s => {
    if (s.id === draft.runId) update({ runEnded: true })
  }, p.onRunChanged)
  // The draft's run still going (or not read yet): Set up waits for it.
  const ownRun = !watching && !!draft.continueColumn && !!draft.runId
  const runBlock = !ownRun ? null
    : !run.status ? (draft.runEnded ? null : 'Loading the run on this column…')
      : runActive(run.status) ? 'A run is still filling this column. Wait for it to finish, or stop it above.' : null
  const onStarted = (runId: string, statusColumn: string, test: boolean) => {
    update({
      continueColumn: statusColumn, columnName: statusColumn, runId, runEnded: false, step: test ? 'test' : 'run',
      ...(test ? { rowsStatus: 'not_enriched' as const } : {}),
    })
    p.onRunStarted(runId)
    // Auto-run goes with the full run: a test on a few rows changes nothing yet.
    if (test) return
    const autoRun = draft.autoRun
    void saveDraftAutorun(sheetId, statusColumn, draft).then(saved => {
      if (saved) { update({ autoRunWas: autoRun }); p.onRunChanged() }
    })
  }
  const shared = {
    sheetId, draft, update, columns, selectedCount: selectedRows.length, selectedRows, rowGeneration: p.rowGeneration,
    hasKey, active: isOpen, filledColumns, onStarted,
  }
  const backLabel = watching && draft.card ? 'Back' : 'Add another enrichment'

  return (
    <Drawer isOpen={isOpen} onClose={onClose} panelClassName="max-w-lg">
      <DrawerHeader
        icon={<div className="bg-cube-black p-1.5"><DatabaseZap className="h-4 w-4 text-white" /></div>}
        title={drawerTitle(step, draft)} description={drawerSubtitle(step, draft, run.status)} onClose={onClose}
        headerRight={step !== 'find' && run.status ? <EnrichHeaderControls run={run} /> : undefined}
      />
      <div className="flex-1 overflow-y-auto" data-testid="enrich-drawer" data-step={step}>
        {opening.loading ? (
          <LoadingSpinner size="sm" message="Loading the enrichment…" className="py-8" />
        ) : step === 'find' ? (
          <FindStep query={draft.query} setQuery={query => update({ query })} hasKey={hasKey} active={isOpen}
            onPick={card => update(d => pickTool(d, card))} />
        ) : step === 'setup' ? (
          <SetupStep {...shared} runBlock={runBlock} onChangeTool={() => update({ step: 'find' })} onCancel={onClose} />
        ) : step === 'test' ? (
          <TestStep {...shared} run={run} onBack={() => update({ step: 'setup' })} />
        ) : (
          <RunStep run={run} onViewResults={onClose} secondaryLabel={backLabel}
            onSecondary={watching ? p.onStopWatching : reset} />
        )}
      </div>
    </Drawer>
  )
}
