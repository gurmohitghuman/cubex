import { useCallback, useEffect, useRef, useState } from 'react'
import type { GridSearchApi } from '@/components/aggrid/types'
import type { WaitingLine } from '@/lib/waiting-runs'

interface Opts {
  sheetId: string | null                       // the sheet shown now
  search: () => GridSearchApi | null           // the grid's handle (useGridHandles)
  navigate: (to: string) => void
  openEnrichment: (runId: string) => void
  openWaterfall: (runId: string) => void
}

type Holder = WaitingLine['holder']
// A column to bring into view on a sheet once its grid has it, and the holder's drawer to open then.
type Pending = { sheetId: string; column: string | null; until: number; holder: Holder }

// How long a column on another sheet is looked for once that sheet opens (its grid loads first).
const REVEAL_FOR_MS = 15_000
const REVEAL_POLL_MS = 200

// The waiting notice's link (components/sheet/WaitingRunsNotice.tsx), to the run that holds the column: its
// column scrolled into view, and an enrichment's or a waterfall's own drawer opened. On another sheet (a
// waterfall's lookup step reads one) that sheet opens first, and the rest follows once its grid has the column.
export function useGoToRun(o: Opts): (line: WaitingLine) => void {
  const { sheetId, search, navigate } = o
  const [pending, setPending] = useState<Pending | null>(null)
  // The openers change on every render of the page; the latest is the one used.
  const openers = useRef(o)
  openers.current = o

  const openDrawer = useCallback((h: Holder) => {
    if (h.kind === 'waterfall') openers.current.openWaterfall(h.runId)
    else if (h.kind === 'enrichment') openers.current.openEnrichment(h.runId)
  }, [])

  useEffect(() => {
    if (!pending || pending.sheetId !== sheetId) return
    const t = setInterval(() => {
      const shown = pending.column !== null && !!search()?.column(pending.column)
      if (!shown && Date.now() <= pending.until) return
      setPending(null)
      openDrawer(pending.holder)
    }, REVEAL_POLL_MS)
    return () => clearInterval(t)
  }, [pending, sheetId, search, openDrawer])

  return useCallback((line: WaitingLine) => {
    const h = line.holder
    if (h.sheetId && h.tableId && h.sheetId !== sheetId) {
      setPending({ sheetId: h.sheetId, column: h.column, until: Date.now() + REVEAL_FOR_MS, holder: h })
      navigate(`/table/${h.tableId}/${h.sheetId}`)
      return
    }
    if (h.column && !search()?.column(h.column) && sheetId) {
      setPending({ sheetId, column: h.column, until: Date.now() + REVEAL_FOR_MS, holder: h })
      return
    }
    openDrawer(h)
  }, [sheetId, search, navigate, openDrawer])
}
