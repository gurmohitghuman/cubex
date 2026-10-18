// "Undo last run" in a run column's menu (AI, HTTP API, enrichment and
// waterfall): the column's newest run that can still be undone is read
// first and shown in a confirm; Undo run puts its cells back. A big undo goes
// on in the background: a toast follows it until it is done. Either way the
// grid reloads with the cells as they are now.
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import type { Sheet } from '@/utils/api'
import { runUndoAPI, type UndoView } from '@/utils/api/run-undo'
import { undoneMessage } from '@/lib/run-undo-copy'
import { UNDO_POLL_MISSES, UNDO_POLL_MS } from '@/lib/constants'

interface Args {
  activeSheet: Sheet | null
  reloadSheetData?: (sheetId: string) => unknown
  // After an undo: the header's "N failed, retry" counts may have changed.
  onUndone?: () => void
}

export interface PendingUndo {
  column: string; view: UndoView | null; loading: boolean; error: string | null; working: boolean
}

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback

export function useRunUndo(a: Args) {
  const sheetId = a.activeSheet?.id ?? null
  const latest = useRef(a)
  latest.current = a
  const [pending, setPending] = useState<PendingUndo | null>(null)
  const seq = useRef(0)
  const polls = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => () => { for (const t of polls.current) clearTimeout(t) }, [])
  // Another sheet: a confirm asked on the last one closes.
  useEffect(() => { seq.current++; setPending(null) }, [sheetId])

  const finished = useCallback((sid: string, v: UndoView, toastId?: string) => {
    toast.success(undoneMessage(v), { id: toastId, duration: 6000 })
    latest.current.reloadSheetData?.(sid)
    latest.current.onUndone?.()
  }, [])

  // A big undo: read how far it got until it is done (a few failed reads in a row end it).
  const follow = useCallback((sid: string, v: UndoView) => {
    const toastId = toast.loading('Undoing the run…')
    let misses = 0
    const tick = () => {
      const t = setTimeout(() => {
        polls.current.delete(t)
        runUndoAPI.read(sid, v.run_type, v.run_id)
          .then(now => { misses = 0; if (now.state === 'undoing') tick(); else finished(sid, now, toastId) })
          .catch(e => {
            if (++misses < UNDO_POLL_MISSES) tick()
            else toast.error(errorOf(e, "Couldn't read how the undo is going."), { id: toastId })
          })
      }, UNDO_POLL_MS)
      polls.current.add(t)
    }
    tick()
  }, [finished])

  const ask = useCallback((column: string) => {
    if (!sheetId) return
    const id = ++seq.current
    setPending({ column, view: null, loading: true, error: null, working: false })
    runUndoAPI.last(sheetId, column)
      .then(view => { if (seq.current === id) setPending(p => (p ? { ...p, view, loading: false } : p)) })
      .catch(e => {
        if (seq.current === id) {
          setPending(p => (p ? { ...p, loading: false, error: errorOf(e, "Couldn't find the column's last run.") } : p))
        }
      })
  }, [sheetId])

  const confirm = async () => {
    const p = pending
    if (!sheetId || !p?.view?.can_undo || p.working) return
    setPending({ ...p, working: true, error: null })
    try {
      const out = await runUndoAPI.undo(sheetId, p.view.run_type, p.view.run_id)
      setPending(null)
      if (out.state === 'undoing') follow(sheetId, out); else finished(sheetId, out)
    } catch (e) {
      setPending(cur => (cur ? { ...cur, working: false, error: errorOf(e, "Couldn't undo the run.") } : cur))
    }
  }
  const cancel = () => { seq.current++; setPending(null) }

  return { ask, pending, confirm, cancel }
}
