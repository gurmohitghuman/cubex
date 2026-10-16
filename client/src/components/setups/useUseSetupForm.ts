import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import {
  setupsAPI, type ApplyBody, type SetupDetail, type SetupEstimate, type SetupSummary,
} from '@/utils/api/setups'
import { matchInput } from '@/lib/setups'
import { setupStarted } from '@/lib/setup-runs-signal'

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback

export interface EstimateState {
  loading: boolean; result: SetupEstimate | null; error: string | null; missing: string[]; taken: string[]
}
const NO_ESTIMATE: EstimateState = { loading: false, result: null, error: null, missing: [], taken: [] }
export const DEFAULT_TEST_ROWS = 10

// The Use a setup dialog's state: the saved setups, the one picked (in full),
// which column of this sheet each of its inputs reads, new names for its
// columns, AI models, every row or a test on the first ones, and the price of
// all that (asked again on every change), then the start.
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

  useEffect(() => {
    if (!open) return
    setSetup(null); setSetups(null); setLoadError(null); setEstimate(NO_ESTIMATE)
    setupsAPI.list().then(setSetups).catch(e => setLoadError(errorOf(e, "Couldn't load your setups.")))
  }, [open])

  const pick = async (id: string | null) => {
    setEstimate(NO_ESTIMATE); setNames({}); setModels({}); setTest({ on: false, rows: DEFAULT_TEST_ROWS })
    if (!id) { setSetup(null); return }
    try {
      const full = await setupsAPI.get(id)
      setInputs(Object.fromEntries(full.inputs.map(i => [i, matchInput(i, columns) ?? ''])))
      setSetup(full)
    } catch (e) {
      toast.error(errorOf(e, "Couldn't open that setup."))
    }
  }

  const body = (estimateOnly: boolean): ApplyBody => ({
    inputs: Object.fromEntries(Object.entries(inputs).filter(([, c]) => c)),
    names: Object.fromEntries(Object.entries(names).filter(([main, n]) => n.trim() && n.trim() !== main)),
    models: Object.fromEntries(Object.entries(models).filter(([, m]) => m.trim())),
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
      setupStarted(sheetId)
      onStarted()
    } catch (e) {
      toast.error(errorOf(e, "Couldn't start the setup."))
    } finally {
      setStarting(false)
    }
  }

  return {
    setups, loadError, setup, pick, inputs, setInputs, names, setNames, models, setModels, test, setTest,
    estimate, starting, canStart, start,
  }
}
export type UseSetupForm = ReturnType<typeof useUseSetupForm>
