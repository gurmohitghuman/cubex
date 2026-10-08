import toast from 'react-hot-toast'
import { autorunAPI } from '@/utils/api'
import type { EnrichDraft } from './draft'

// Once a run has started (its column exists), Set up's auto-run choice goes to
// the column: on with "Only run if" and the daily cap, or off when it was on.
// The run already started, so a refusal here is a toast, not a stop.
export async function saveDraftAutorun(sheetId: string, column: string, d: EnrichDraft): Promise<boolean> {
  if (!d.autoRun && !d.autoRunWas) return false
  try {
    await autorunAPI.save(sheetId, d.autoRun ? {
      column, enabled: true, dailyCapUsd: d.autoRunCapUsd,
      where: d.conditions.map(c => ({ column: c.column, op: c.op, value: c.value })),
    } : { column, enabled: false })
    return true
  } catch (e: any) {
    const why = e?.response?.data?.error || 'try again from the column menu.'
    toast.error(`The run started, but auto-run wasn't saved: ${why}`)
    return false
  }
}
