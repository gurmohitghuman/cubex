import { SheetData } from '@/utils/api'
import { RECENTLY_SAVED_TTL_MS } from '@/lib/constants'

// A pending cell edit, as held by the autosave queue (useCellOps.CellChange).
// Re-declared structurally here to avoid a circular import.
export interface PendingEdit { sheetId: string; rowIndex: number; columnName: string; value: string }
// An acked-but-not-loud-reloaded edit (useCellOps.SavedCell), same rationale.
export interface SavedCell { sheetId: string; rowIndex: number; columnName: string; value: string; at: number }

// Silent (background) reloads must not clobber the user's edits. Two sources of
// a "newer than the server GET" value:
//   1. pendingEdits — un-flushed edits (PUT not sent / in flight). The GET may
//      predate the PUT, so a flat replace would show the old value while the
//      PUT later commits the new one (UI ≠ DB).
//   2. recentlySaved — edits whose PUT is ACKED but which a loud reload hasn't
//      re-fetched. After the ack the value lives only in the prior sheetData; a
//      flat replace from a GET that read pre-PUT state would lose it. We
//      re-overlay, then self-clean entries the GET now reflects (server caught
//      up → drop, so a genuinely newer server value is no longer masked).
// Pending wins over recently-saved (it's the fresher of the two). We do NOT
// blanket local-wins (loadMoreData can; this path can't) — that would mask
// AI/HTTP run results and cleared '⏳ Processing...' placeholders on cells the
// user never touched, which is exactly what the silent reload exists to
// surface. Loud loads take server state verbatim.
//
// Mutates data.data.rows in place (the caller commits `data` right after) and
// self-cleans reconciled/expired entries out of the recentlySaved map.
export function overlayLocalEdits(
  data: SheetData,
  sheetId: string,
  pendingEdits: PendingEdit[],
  recentlySaved: Map<string, SavedCell>,
): void {
  const byRow = new Map<number, Record<string, string>>()
  const now = Date.now()
  // recently-saved first (lower precedence), self-cleaning as we go. Read
  // the structured value object — never parse the key.
  for (const [key, e] of Array.from(recentlySaved.entries())) {
    if (e.sheetId !== sheetId) continue
    // Past the TTL the server is authoritative; drop so a later run that
    // legitimately changed this cell isn't masked by the older value.
    if (now - e.at > RECENTLY_SAVED_TTL_MS) { recentlySaved.delete(key); continue }
    const serverRow = data.data.rows.find(r => r.rowIndex === e.rowIndex)
    // Server already carries our saved value → reconciled, stop overlaying it.
    if (serverRow && (serverRow.data as Record<string, string>)[e.columnName] === e.value) {
      recentlySaved.delete(key)
      continue
    }
    const m = byRow.get(e.rowIndex) || {}
    m[e.columnName] = e.value
    byRow.set(e.rowIndex, m)
  }
  // pending edits second (higher precedence — overwrite recently-saved).
  for (const c of pendingEdits) {
    if (c.sheetId !== sheetId) continue
    const m = byRow.get(c.rowIndex) || {}
    m[c.columnName] = c.value
    byRow.set(c.rowIndex, m)
  }
  if (byRow.size > 0) {
    data.data.rows = data.data.rows.map(r => {
      const overlay = byRow.get(r.rowIndex)
      return overlay ? { ...r, data: { ...r.data, ...overlay } } : r
    })
  }
}
