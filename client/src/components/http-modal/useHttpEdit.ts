import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { httpAPI } from '@/utils/api'
import { HTTPAPIConfig } from './types'
import { fromServerConfig, toServerConfig } from './toServerConfig'
import { validateHTTPConfig } from './validateHTTPConfig'

interface Args {
  isOpen: boolean
  sheetId: string
  // The column its menu's Edit opened the dialog on; null: a new column.
  editColumn: string | null
  config: HTTPAPIConfig
  setConfig: (c: HTTPAPIConfig) => void
  setMasterColumnName: (v: string) => void
  setErrors: (e: Record<string, string>) => void
  onSuccess: () => void
  onRunStarted?: (runId: string) => void
  close: () => void
}

// Editing an HTTP API column (its menu's Edit): the dialog opens on the column's newest setup, and its Save keeps
// the new one as the column's without running (saveOnly; the server makes every check a run makes), or saves it
// and runs the column again on all its rows (its rerun, which reads the setup just saved). keep: on the review
// step, the fields picked there; on Configure, every mapped column.
export function useHttpEdit(a: Args) {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const editing = !!a.editColumn

  useEffect(() => {
    if (!a.isOpen || !a.editColumn) return
    let live = true
    setLoading(true)
    httpAPI.columnSetup(a.sheetId, a.editColumn)
      .then(s => { if (live) { a.setConfig(fromServerConfig(s.config)); a.setMasterColumnName(s.column) } })
      .catch((e: any) => {
        if (!live) return
        toast.error(e?.response?.data?.error || 'Couldn\'t open this column\'s setup.')
        a.close()
      })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [a.isOpen, a.editColumn, a.sheetId]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (run: boolean, keep?: Set<string>) => {
    if (!a.editColumn || saving) return
    const mapping = a.config.responseMapping.filter(m => m.columnName.trim() && (!keep || keep.has(m.columnName)))
    const config = { ...a.config, responseMapping: mapping }
    if (!validateHTTPConfig(config, a.setErrors)) return toast.error('Please fix configuration errors')
    setSaving(true)
    let saved = false
    try {
      await httpAPI.startRun(a.sheetId, toServerConfig(config), a.editColumn, true)
      saved = true
      if (run) a.onRunStarted?.((await httpAPI.rerun(a.sheetId, a.editColumn)).runId)
      else toast.success('Setup saved. Nothing ran.')
      a.onSuccess()
      a.close()
    } catch (e: any) {
      const why = e?.response?.data?.error
      if (!saved) toast.error(why || 'Couldn\'t save the setup.')
      else {
        toast.error(`The setup was saved, but its run didn't start${why ? `: ${why}` : '.'}`)
        a.onSuccess()
      }
    } finally { setSaving(false) }
  }

  // The steps' edit buttons (undefined for a new column): keep, the fields the review step picked.
  const prop = (keep?: Set<string>) => (editing
    ? { saving: saving || loading, onSave: (run: boolean) => save(run, keep) } : undefined)
  return { editing, loading, saving, save, prop }
}
