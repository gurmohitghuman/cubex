import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { viewsAPI, type Sheet, type SheetData, type ViewStarter } from '@/utils/api'
import type { WhereItem } from '@/utils/api/views'
import { activeViewOf } from '@/lib/views'
import { viewChanged } from './viewChanged'
import { PENDING_HIDDEN_MS } from '@/lib/constants'

interface Args {
  activeSheet: Sheet | null
  sheetData: SheetData | null
  setSheetData: React.Dispatch<React.SetStateAction<SheetData | null>>
  reloadActiveSheet: (opts?: { silent?: boolean }) => Promise<void> | void
}

// A change made in a view that is no longer showing: the sheet reloads, no toast.
const VIEW_MOVED = 'Another view is showing now.'

const errorText = (e: unknown, fallback: string): string =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback

/**
 * Saved views (server services/views.ts): switch, new (a copy of the active
 * one), rename and describe, delete, ready-made ones, hide and show columns.
 * The views come with every sheet load. `saveChain` is shared with the filter
 * hooks, so a filter change and a view switch reach the server in the order
 * they were made (a filter save landing after a switch would change the wrong
 * view). Hiding is optimistic: the column goes at once and the save follows.
 */
export function useSheetViews({ activeSheet, sheetData, setSheetData, reloadActiveSheet }: Args) {
  const saveChain = useRef<Promise<unknown>>(Promise.resolve())
  const hideSeq = useRef(0)
  // Hidden columns not saved yet, for the view they were changed in.
  const [pending, setPending] = useState<{ viewId: string; hidden: string[]; saved?: boolean } | null>(null)
  const views = sheetData?.data.views ?? []
  const active = activeViewOf(sheetData)
  const columns = sheetData?.data.columns
  // Keyed by content: a reload brings new view objects, and a new list here
  // would rebuild every grid column (useColumnDefs).
  const live = new Set(columns ?? [])
  const hiddenKey = (pending && pending.viewId === active?.id ? pending.hidden : active?.hidden_columns ?? [])
    .filter(c => live.has(c)).join('\u0000')
  const hiddenColumns = useMemo(() => (hiddenKey ? hiddenKey.split('\u0000') : []), [hiddenKey])

  // One view change after the ones before it, then a reload of the sheet.
  // null: done; else what went wrong (another view showing reloads it).
  const run = useCallback((fallback: string, call: (sheetId: string) => Promise<unknown>) => {
    if (!activeSheet) return Promise.resolve<string | null>(fallback)
    const sheetId = activeSheet.id
    const done = saveChain.current.then(() => call(sheetId)).then(async () => {
      if (activeSheet.id === sheetId) await reloadActiveSheet({ silent: true })
      return null
    }).catch(async e => {
      if (!viewChanged(e)) return errorText(e, fallback)
      await reloadActiveSheet({ silent: true })
      return VIEW_MOVED
    })
    saveChain.current = done
    return done
  }, [activeSheet, reloadActiveSheet])
  const queue = useCallback((fallback: string, call: (sheetId: string) => Promise<unknown>) =>
    run(fallback, call).then(problem => {
      if (problem && problem !== VIEW_MOVED) toast.error(problem)
      return problem === null
    }), [run])

  const switchTo = useCallback((viewId: string) =>
    queue('Could not switch views. Please try again.', id => viewsAPI.activate(id, viewId)), [queue])
  const create = useCallback((name: string, description: string) =>
    queue('Could not add the view. Please try again.', id => viewsAPI.create(id, name, description)), [queue])
  const rename = useCallback((viewId: string, name: string, description: string) =>
    queue('Could not save the view. Please try again.', id => viewsAPI.update(id, viewId, { name, description })),
  [queue])
  const remove = useCallback((viewId: string) =>
    queue('Could not delete the view. Please try again.', id => viewsAPI.remove(id, viewId)), [queue])
  const starter = useCallback((kind: ViewStarter) =>
    queue('Could not add the view. Please try again.', id => viewsAPI.starter(id, kind)), [queue])
  const activeId = active?.id ?? null
  // The filter panel's whole filter; the panel shows what went wrong itself.
  const saveFilters = useCallback((where: WhereItem[] | null) =>
    run('Could not apply the filter. Please try again.', id => viewsAPI.saveFilters(id, activeId, where)),
  [run, activeId])

  const setHidden = useCallback((next: string[]) => {
    if (!activeSheet || !active) return
    const sheetId = activeSheet.id
    const viewId = active.id
    const seq = ++hideSeq.current
    setPending({ viewId, hidden: next })
    saveChain.current = saveChain.current
      .then(() => viewsAPI.update(sheetId, viewId, { hiddenColumns: next }))
      .then(saved => setSheetData(prev => (prev?.sheet.id !== sheetId ? prev : {
        ...prev, data: { ...prev.data, views: prev.data.views?.map(v => (v.id === saved.id ? saved : v)) },
      })))
      // Saved: the pending list stays until a load shows it (a reload that began
      // before the save would otherwise bring the old list back for a moment).
      .then(() => {
        if (seq !== hideSeq.current) return
        setPending(p => (p ? { ...p, saved: true } : p))
        setTimeout(() => { if (seq === hideSeq.current) setPending(null) }, PENDING_HIDDEN_MS)
      })
      .catch(e => {
        toast.error(errorText(e, 'Could not save the hidden columns. Please try again.'))
        if (seq === hideSeq.current) setPending(null)
      })
  }, [activeSheet, active, setSheetData])

  const loadedKey = active?.hidden_columns.join('\u0000')
  useEffect(() => {
    if (pending?.saved && (pending.viewId !== active?.id || pending.hidden.join('\u0000') === loadedKey)) {
      setPending(null)
    }
  }, [pending, active?.id, loadedKey])

  const hiddenSet = useMemo(() => new Set(hiddenColumns), [hiddenColumns])
  const hideColumn = useCallback((column: string) => setHidden([...hiddenColumns, column]),
    [hiddenColumns, setHidden])

  return {
    views, active, hiddenColumns, hiddenSet, saveChain,
    switchTo, create, rename, remove, starter, saveFilters, setHidden, hideColumn,
  }
}

export type SheetViews = ReturnType<typeof useSheetViews>
