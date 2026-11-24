import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { setupsAPI, type SetupPlan, type SheetSetupStep } from '@/utils/api/setups'
import { withUpstream } from '@/lib/setups'
import { useTypedReads } from '@/hooks/useTypedReads'

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback

export interface PlanState { loading: boolean; result: SetupPlan | null; error: string | null }
const NO_PLAN: PlanState = { loading: false, result: null, error: null }

// The Save as setup dialog's state: the sheet's filled columns, the ones
// ticked (a column brings the columns it reads, down the chain), what a setup
// of them would hold (asked again on every change), and saving it.
export function useSaveSetupForm(p: { sheetId: string; column: string | null; open: boolean; onSaved: () => void }) {
  const { sheetId, column, open, onSaved } = p
  const [steps, setSteps] = useState<SheetSetupStep[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [plan, setPlan] = useState<PlanState>(NO_PLAN)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    let live = true
    setSteps(null); setLoadError(null); setPicked([]); setPlan(NO_PLAN); setName(''); setDescription('')
    setupsAPI.sheetSteps(sheetId)
      .then(s => { if (live) { setSteps(s); setPicked(column ? withUpstream(s, [column]) : []) } })
      .catch(e => { if (live) setLoadError(errorOf(e, "Couldn't read this sheet's columns.")) })
    return () => { live = false }
  }, [open, sheetId, column])

  const pickedKey = JSON.stringify(picked)
  // Columns are ticked, not typed: read at once, one read at a time, an older answer never shown
  // (lib/typedReads.ts), so a burst of ticks makes at most two reads.
  const ask = useTypedReads<SetupPlan>(a => setPlan(a.ok
    ? { loading: false, result: a.value, error: null }
    : { loading: false, result: null, error: errorOf(a.error, "Couldn't check these columns.") }), { waitMs: 0 })
  useEffect(() => {
    if (!open || picked.length === 0) { setPlan(NO_PLAN); ask('', null); return }
    setPlan(prev => ({ ...prev, loading: true, error: null }))
    const cols = picked
    ask(`${sheetId}\n${pickedKey}`, signal => setupsAPI.plan(sheetId, cols, signal))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sheetId, pickedKey, ask])

  // Ticking a column brings what it reads; unticking takes only that one off
  // (what it made then becomes something the setup needs from the sheet).
  const toggle = (col: string) => {
    if (!steps) return
    setPicked(prev => (prev.includes(col) ? prev.filter(c => c !== col) : withUpstream(steps, [...prev, col])))
  }

  const canSave = !!name.trim() && !!plan.result && !plan.loading && !plan.error && !saving
  const save = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      const saved = await setupsAPI.save(sheetId, { name: name.trim(), description, columns: picked })
      toast.success(`Saved the setup "${saved.name}". Use it on any sheet from the Setups menu.`)
      onSaved()
    } catch (e) {
      toast.error(errorOf(e, "Couldn't save the setup."))
    } finally {
      setSaving(false)
    }
  }

  return {
    steps, loadError, picked, toggle, plan, name, setName, description, setDescription, saving, canSave, save,
  }
}
