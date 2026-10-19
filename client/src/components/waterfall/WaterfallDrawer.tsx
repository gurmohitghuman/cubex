import React, { useEffect, useMemo, useState } from 'react'
import { Select } from '@/components/ui/Select'
import { Layers } from 'lucide-react'
import { Drawer, DrawerHeader } from '@/components/Drawer'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ENRICH_TEST_ROWS, WATERFALL_DRY_MAX_ROWS, WATERFALL_DRY_ROWS } from '@/lib/constants'
import { waterfallAPI } from '@/utils/api/waterfall'
import { draftProblem, fromSetup, resultLabel, toInput, type WaterfallDraft } from './draft'
import { StartPicker } from './StartPicker'
import { stepInputKeys } from './step-copy'
import { InputsSection } from './InputsSection'
import { StepsSection } from './StepsSection'
import { OptionsSection } from './OptionsSection'
import { WaterfallEstimateBox } from './WaterfallEstimateBox'
import { RunProgress } from './RunProgress'
import { DryRunPanel } from './DryRunPanel'
import { startCopy, type StartChoice } from './start-copy'
import { useWaterfallEstimate, useWaterfallRun } from './useWaterfall'

export type WaterfallOpenTarget = { kind: 'new' } | { kind: 'edit'; column: string } | { kind: 'run'; runId: string }

interface Props {
  isOpen: boolean
  onClose: () => void
  sheetId: string
  columns: string[]
  selectedRows: number[]
  rowGeneration?: number
  target: WaterfallOpenTarget | null
  onRunStarted: (runId: string) => void
  onRunChanged: () => void
}

// A new waterfall's draft is kept per sheet while the page is open: closing
// and reopening the drawer picks up where you were.
const drafts = new Map<string, WaterfallDraft>()
const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="space-y-2"><h3 className="text-sm font-medium text-gray-900">{title}</h3>{children}</section>
)

// "Waterfall": one value per row (a work email, a phone…) from ordered steps,
// stopping at the first answer. Pick what it finds (or a starter), map the inputs once, add
// the steps, see the average and the most a row costs, then run on a few rows
// or all of them. Edit opens a column's own setup; a run shows its progress.
export const WaterfallDrawer: React.FC<Props> = (p) => {
  const { isOpen, sheetId, columns } = p
  const [draft, setDraftState] = useState<WaterfallDraft | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<StartChoice | null>(null)
  const [dryRunId, setDryRunId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const setDraft = (d: WaterfallDraft | null) => {
    setDraftState(d)
    if (d && !d.continueColumn) drafts.set(sheetId, d); else if (!d) drafts.delete(sheetId)
  }
  const update = (patch: Partial<WaterfallDraft>) => draft && setDraft({ ...draft, ...patch })

  useEffect(() => {
    if (!isOpen || !p.target) return
    setError(null)
    const t = p.target
    setDryRunId(null)
    if (t.kind === 'run') { setRunId(t.runId); return }
    setRunId(null)
    if (t.kind === 'new') { setDraftState(drafts.get(sheetId) ?? null); return }
    setLoading(true)
    waterfallAPI.columnSetup(sheetId, t.column)
      .then(s => { setDraftState(fromSetup(s)); if (s.activeRunId) setRunId(s.activeRunId) })
      .catch(e => setError(errorOf(e, "Couldn't open this waterfall.")))
      .finally(() => setLoading(false))
  }, [isOpen, p.target, sheetId]) // eslint-disable-line react-hooks/exhaustive-deps

  // A run the drawer opened on, found active on its column or just started
  // shows its progress until Done.
  const status = useWaterfallRun(runId, isOpen, p.onRunChanged)
  const watching = !!runId
  const problem = draft ? draftProblem(draft) : null
  const choice = { test: null, rowIndexes: p.selectedRows, rowGeneration: p.rowGeneration ?? null }
  const input = useMemo(() => (draft && !problem ? toInput(draft, choice) : null),
    [draft, problem, p.selectedRows, p.rowGeneration]) // eslint-disable-line react-hooks/exhaustive-deps
  const est = useWaterfallEstimate(sheetId, input, isOpen && !watching && !dryRunId)

  // A dry run takes the selected rows when the run would (at most 10), else the first few.
  const dryRows = draft?.rowsMode === 'selected' && p.selectedRows.length
    ? Math.min(p.selectedRows.length, WATERFALL_DRY_MAX_ROWS) : WATERFALL_DRY_ROWS
  const start = async (c: StartChoice) => {
    if (!draft) return
    setStarting(true)
    setError(null)
    try {
      if (c.kind === 'dry') {
        // A dry run takes at most 10 picked rows: the first of those selected.
        const rowIndexes = p.selectedRows.slice(0, WATERFALL_DRY_MAX_ROWS)
        const dry = await waterfallAPI.startDryRun(sheetId,
          toInput(draft, { ...choice, rowIndexes, dry: { only: c.only } }))
        setConfirm(null)
        setDryRunId(dry.runId)
        return
      }
      const test = c.kind === 'test' ? ENRICH_TEST_ROWS : null
      const out = await waterfallAPI.start(sheetId, toInput(draft, { ...choice, test }))
      setConfirm(null)
      setRunId(out.runId)
      // The column exists now: the next run adds to it, on the rows it hasn't done.
      setDraft({ ...draft, columnName: out.resultColumn, continueColumn: true, rowsStatus: 'not_enriched' })
      drafts.delete(sheetId)
      p.onRunStarted(out.runId)
    } catch (e) {
      setConfirm(null)
      setError(errorOf(e, "Couldn't start the waterfall."))
    } finally { setStarting(false) }
  }

  const title = draft
    ? `${draft.continueColumn ? 'Edit' : 'New'} waterfall: ${resultLabel(draft.resultType)}`
    : 'Waterfall'
  const e = est.estimate
  // Run only on the estimate of the draft as it is now (the last one stays shown while the next loads).
  const runnable = !problem && !!e && !est.loading && !starting
  const copy = e && confirm ? startCopy(confirm, e, dryRows) : null
  return (
    <Drawer isOpen={isOpen} onClose={p.onClose} panelClassName="max-w-lg">
      <DrawerHeader icon={<div className="bg-cube-black p-1.5"><Layers className="h-4 w-4 text-white" /></div>}
        title={title} description="One value per row: each step in turn until one answers" onClose={p.onClose} />
      <div className="flex-1 overflow-y-auto" data-testid="waterfall-drawer">
        {loading ? <LoadingSpinner size="sm" message="Loading the waterfall…" className="py-8" />
          : dryRunId ? <DryRunPanel runId={dryRunId} onBack={() => setDryRunId(null)} />
          : watching ? (
            <RunProgress status={status} onChanged={p.onRunChanged}
              onDone={() => { setRunId(null); if (!draft) p.onClose() }} />
          ) : !draft ? (
            <StartPicker columns={columns} error={error} onPick={setDraft} />
          ) : (
            <div className="p-4 space-y-5">
              <Section title="Result">
                <label className="block space-y-1">
                  <span className="meta-label">Column</span>
                  <input className="input w-full" value={draft.columnName} aria-label="Result column"
                    disabled={draft.continueColumn} onChange={ev => update({ columnName: ev.target.value })} />
                </label>
                {draft.resultType === 'phone' && (
                  <Select<string> className="w-full" value={draft.phoneFormat} label="Phone format"
                    onChange={v => update({ phoneFormat: v as WaterfallDraft['phoneFormat'] })} options={[
                      { value: 'international', label: '+1 415 555 2671' },
                      { value: 'e164', label: '+14155552671' },
                      { value: 'national', label: '(415) 555-2671 in its own country' },
                    ]} />
                )}
              </Section>
              <Section title="Inputs">
                <InputsSection inputs={draft.inputs} columns={columns} onChange={inputs => update({ inputs })}
                  inUse={new Set(draft.steps.flatMap(s => stepInputKeys(s, draft.inputs.map(i => i.key))))} />
              </Section>
              <Section title="Steps">
                <StepsSection sheetId={sheetId} steps={draft.steps} inputs={draft.inputs} resultType={draft.resultType}
                  resultLabel={resultLabel(draft.resultType)} onChange={steps => update({ steps })}
                  onTest={runnable ? only => setConfirm({ kind: 'dry', only }) : undefined} />
              </Section>
              <Section title="Options">
                <OptionsSection sheetId={sheetId} draft={draft} update={update} selectedCount={p.selectedRows.length}
                  active={isOpen} />
              </Section>
              <WaterfallEstimateBox estimate={e} loading={est.loading} error={est.error} blocked={problem}
                nothingToRun={est.nothingToRun} />
              {error && <p className="text-xs text-red-600" data-testid="waterfall-error">{error}</p>}
              <div className="flex gap-2 justify-end">
                <button type="button" className="btn-secondary" disabled={!runnable}
                  title="Every step on a few rows, for real; nothing is written to the sheet"
                  onClick={() => setConfirm({ kind: 'dry', only: null })}>Try on {dryRows} rows</button>
                <button type="button" className="btn-secondary" disabled={!runnable}
                  onClick={() => setConfirm({ kind: 'test' })}>Run on {ENRICH_TEST_ROWS} rows</button>
                <button type="button" className="btn-primary" disabled={!runnable || e?.rows === 0}
                  onClick={() => setConfirm({ kind: 'all' })}>Run</button>
              </div>
            </div>
          )}
      </div>
      <ConfirmDialog isOpen={!!confirm} title={copy?.title ?? ''} message={copy?.text ?? ''}
        confirmText="Run" isLoading={starting} onConfirm={() => confirm && start(confirm)}
        onCancel={() => setConfirm(null)} />
    </Drawer>
  )
}
