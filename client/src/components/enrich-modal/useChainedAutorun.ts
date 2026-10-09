import { useEffect, useState } from 'react'
import { autorunAPI } from '@/utils/api'
import type { EnrichEstimate } from '@/utils/api'
import type { EnrichDraft } from './draft'
import { chainText, writtenColumns } from './chain-copy'

// The Run confirm's "Also runs" line, read when the confirm opens: '' when the
// run sets nothing off, the read failed or the rows aren't counted, null while it loads.
export function useChainedAutorun(
  sheetId: string, open: boolean, draft: EnrichDraft, rows: number | null,
  estimate: EnrichEstimate | null, destName: string | null,
): string | null {
  const [text, setText] = useState<string | null>(null)
  const written = writtenColumns(draft)
  const l = draft.list
  const destId = l && l.dest.kind === 'sheet' ? l.dest.sheetId : null
  const destRows = l ? estimate?.list?.addUpTo ?? 0 : 0
  const key = open && rows !== null ? JSON.stringify([sheetId, rows, written, destId, destRows, destName]) : ''

  useEffect(() => {
    if (!open) { setText(null); return }
    // Rows not counted (an own-key tool whose counts didn't load): nothing to quote.
    if (!key || rows === null) { setText(''); return }
    setText(null)
    let alive = true
    Promise.all([
      autorunAPI.estimate(sheetId, rows, { after: written }),
      destId && destRows > 0 ? autorunAPI.estimate(destId, destRows, { quick: true }) : Promise.resolve(null),
    ]).then(([here, there]) => {
      if (!alive) return
      const dest = there ? { name: destName ?? 'the other sheet', runs: there.autoRuns } : undefined
      setText(chainText(here.autoRuns, dest))
    }).catch(() => { if (alive) setText('') })
    return () => { alive = false }
    // key holds every input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open])
  return text
}
