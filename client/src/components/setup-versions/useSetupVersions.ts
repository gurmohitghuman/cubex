import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { setupVersionsAPI, type RestoreAnswer, type SetupVersion } from '@/utils/api/setup-versions'

// The setup versions dialog's data: the sheet's versions, and one version
// compared with the sheet now, then restored. Each answer is dropped when the
// dialog moved on (another sheet, another version) before it came back.
export type VersionsView =
  | { kind: 'list' }
  | { kind: 'compare'; version: SetupVersion; plan: RestoreAnswer | null }
  | { kind: 'done'; answer: RestoreAnswer }

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback

export function useSetupVersions(sheetId: string | null, onRestored: (sheetId: string) => void) {
  const [versions, setVersions] = useState<SetupVersion[] | null>(null)
  const [view, setView] = useState<VersionsView>({ kind: 'list' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listAsk = useRef(0)
  const viewAsk = useRef(0)

  const load = useCallback(async () => {
    if (!sheetId) return
    const n = ++listAsk.current
    try {
      const list = await setupVersionsAPI.list(sheetId)
      if (n === listAsk.current) setVersions(list)
    } catch (e) {
      if (n === listAsk.current) setError(errorOf(e, 'The versions could not be loaded.'))
    }
  }, [sheetId])

  useEffect(() => {
    viewAsk.current++
    setVersions(null)
    setView({ kind: 'list' })
    setError(null)
    void load()
  }, [load])

  const run = async <T,>(fn: () => Promise<T>, fallback: string): Promise<T | null> => {
    setBusy(true)
    setError(null)
    try { return await fn() } catch (e) { setError(errorOf(e, fallback)); return null } finally { setBusy(false) }
  }

  const save = async (name: string): Promise<boolean> => {
    if (!sheetId) return false
    const saved = await run(() => setupVersionsAPI.save(sheetId, name), 'The version could not be saved.')
    if (!saved) return false
    toast.success(`Saved "${saved.name}"`)
    await load()
    return true
  }

  const rename = async (v: SetupVersion, name: string): Promise<boolean> => {
    if (!sheetId) return false
    const done = await run(() => setupVersionsAPI.rename(sheetId, v.id, name), 'The version could not be renamed.')
    if (done) await load()
    return !!done
  }

  const remove = async (v: SetupVersion) => {
    if (!sheetId) return
    if (await run(() => setupVersionsAPI.remove(sheetId, v.id).then(() => true), 'The version could not be deleted.')) {
      await load()
    }
  }

  const compare = async (v: SetupVersion) => {
    if (!sheetId) return
    const n = ++viewAsk.current
    setView({ kind: 'compare', version: v, plan: null })
    const plan = await run(() => setupVersionsAPI.compare(sheetId, v.id), 'The version could not be compared.')
    if (n !== viewAsk.current) return
    if (plan) setView({ kind: 'compare', version: v, plan })
    else { setView({ kind: 'list' }); void load() }  // deleted elsewhere, say: the list shows what's there
  }

  const restore = async (v: SetupVersion) => {
    if (!sheetId) return
    const answer = await run(() => setupVersionsAPI.restore(sheetId, v.id), 'The version could not be restored.')
    if (!answer) return
    setView({ kind: 'done', answer })
    if (!answer.nothing) onRestored(sheetId)
    void load()
  }

  const back = () => { viewAsk.current++; setError(null); setView({ kind: 'list' }) }

  return { versions, view, busy, error, save, rename, remove, compare, restore, back }
}
