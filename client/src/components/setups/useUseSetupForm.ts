import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import {
  setupsAPI, type ApplyBody, type SetupDetail, type SetupEstimate, type SetupSummary,
} from '@/utils/api/setups'
import { matchInput } from '@/lib/setups'
import { setupRunsChanged } from '@/lib/setup-runs-signal'

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback
const AI_SUFFIX = / \((Output|Status)\)$/

// The column a step's main column becomes (the server's rule): a new name for
// an AI step's "(Output)" or "(Status)" column keeps that ending.
function finalMain(column: string, renamed: string | undefined): string {
  const n = renamed?.replace(/["\\]/g, '').replace(/\s+/g, ' ').trim()
  if (!n || n === column) return column
  const suffix = AI_SUFFIX.exec(column)?.[0]
  return suffix ? `${n.replace(AI_SUFFIX, '')}${suffix}` : n
}

export interface EstimateState {
  loading: boolean; result: SetupEstimate | null; error: string | null; missing: string[]; taken: string[]
}
const NO_ESTIMATE: EstimateState = { loading: false, result: null, error: null, missing: [], taken: [] }
export const DEFAULT_TEST_ROWS = 10

// The Use a setup dialog's state: the saved setups, the one picked (in full),
// which column of this sheet each of its inputs reads, new names for its
// columns, AI models, every row or a test on the first ones, and the price of
// all that (asked again on every change), then the start. A setup used on this
// sheet before starts from the choices it was used with, so the steps whose
// columns the sheet has carry them on (they fill only the rows not done yet).
// usedAt: when that was, for the dialog to say so.
export function useUseSetupForm(p: { sheetId: string; columns: string[]; open: boolean; onStarted: () => void }) {
  const { sheetId, columns, open, onStarted } = p
  const [setups, setSetups] = useState<SetupSummary[] | null>(null)
  const [setup, setSetup] = useState<SetupDetail | null>(null)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [names, setNames] = useState<Record<string, string>>({})
  const [models, setModels] = useState<Record<string, string>>({})
  const [test, setTest] = useState<{ on: boolean; rows: number }>({ on: false, rows: DEFAULT_TEST_ROWS })
  const [estimate, setEstimate] = useState<EstimateState>(NO_ESTIMATE)
  const [starting, setStarting] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [usedAt, setUsedAt] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setSetup(null); setSetups(null); setLoadError(null); setEstimate(NO_ESTIMATE)
    setupsAPI.list().then(setSetups).catch(e => setLoadError(errorOf(e, "Couldn't load your setups.")))
  }, [open])

  // The newest pick wins: a slower answer to an earlier one is dropped.
  const picking = useRef(0)
  const pick = async (id: string | null) => {
    const turn = ++picking.current
    setEstimate(NO_ESTIMATE); setNames({}); setModels({}); setTest({ on: false, rows: DEFAULT_TEST_ROWS })
    setUsedAt(null)
    if (!id) { setSetup(null); return }
    try {
      const [full, runs] = await Promise.all([setupsAPI.get(id), setupsAPI.runs(sheetId, id).catch(() => [])])
      if (turn !== picking.current) return
      const last = runs.find(r => r.choices)
      const was = last?.choices?.inputs ?? {}
      setInputs(Object.fromEntries(full.inputs.map(i => [i,
        was[i] && columns.includes(was[i]) ? was[i] : matchInput(i, columns) ?? ''])))
      if (last) {
        setNames(last.choices?.names ?? {})
        setModels(last.choices?.models ?? {})
        setUsedAt(last.created_at)
      }
      setSetup(full)
    } catch (e) {
      toast.error(errorOf(e, "Couldn't open that setup."))
    }
  }

  const body = (estimateOnly: boolean): ApplyBody => ({
    inputs: Object.fromEntries(Object.entries(inputs).filter(([, c]) => c)),
    names: Object.fromEntries(Object.entries(names).filter(([main, n]) => n.trim() && n.trim() !== main)),
    // A step whose column this sheet has carries it on with the column's own model: none is sent for it.
    models: Object.fromEntries(Object.entries(models)
      .filter(([main, m]) => m.trim() && !columns.includes(finalMain(main, names[main])))),
    firstRows: test.on ? test.rows : null,
    estimateOnly,
  })
  const key = JSON.stringify([setup?.id, inputs, names, models, test])
  useEffect(() => {
    if (!open || !setup) return
    const ctl = new AbortController()
    setEstimate(prev => ({ ...prev, loading: true }))
    const t = setTimeout(() => {
      setupsAPI.apply(sheetId, setup.id, body(true), ctl.signal)
        .then(out => setEstimate({ ...NO_ESTIMATE, result: 'estimate' in out ? out.estimate : null }))
        .catch(e => {
          if (ctl.signal.aborted) return
          const d = e?.response?.data ?? {}
          setEstimate({ loading: false, result: null, error: errorOf(e, "Couldn't price it."),
            missing: d.missing ?? [], taken: d.taken ?? [] })
        })
    }, 400)
    return () => { clearTimeout(t); ctl.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sheetId, key])

  const canStart = !!setup && !!estimate.result && !estimate.loading && !estimate.error && !starting
  const start = async () => {
    if (!setup || !canStart) return
    setStarting(true)
    try {
      await setupsAPI.apply(sheetId, setup.id, body(false))
      toast.success(`Started "${setup.name}". Its columns fill in step by step.`)
      setupRunsChanged(sheetId)
      onStarted()
    } catch (e) {
      toast.error(errorOf(e, "Couldn't start the setup."))
    } finally {
      setStarting(false)
    }
  }

  // Each step's mode by the setup's order, once priced (a step carrying a sheet column on is 'again').
  const modes = estimate.result?.steps.map(st => st.mode) ?? []
  return {
    setups, loadError, setup, pick, inputs, setInputs, names, setNames, models, setModels, test, setTest,
    estimate, starting, canStart, start, usedAt, modes,
  }
}
export type UseSetupForm = ReturnType<typeof useUseSetupForm>
