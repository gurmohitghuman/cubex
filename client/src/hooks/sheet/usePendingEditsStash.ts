import { useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import type { Sheet } from '@/utils/api'
import { stashPendingEdits, takeStashedEdits } from './pendingEditsStash'
import type { CellChange } from './cellQueue'

interface UsePendingEditsStashArgs {
  activeSheet: Sheet | null
  unsavedChanges: CellChange[]
  setUnsavedChanges: React.Dispatch<React.SetStateAction<CellChange[]>>
  rowGenerationRef: React.MutableRefObject<Map<string, number>>
}

// Session-expiry safety net for the autosave queue (useCellOps).
export const usePendingEditsStash = ({
  activeSheet, unsavedChanges, setUnsavedChanges, rowGenerationRef,
}: UsePendingEditsStashArgs): void => {
  // Mirror the queue to localStorage on every change, grouped per sheet, so a
  // hard teardown (the 401 session-expiry redirect in client.ts → window.location
  // wipes in-memory state) doesn't lose un-flushed edits. Clearing a sheet's stash
  // when its edits drain prevents re-applying already-saved edits on next load.
  // stashedSheetsRef tracks which sheets had a stash so a now-empty sheet (queue
  // drained) gets its key cleared even though it's absent from the current group.
  const stashedSheetsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const bySheet = new Map<string, CellChange[]>()
    for (const c of unsavedChanges) {
      const g = bySheet.get(c.sheetId)
      if (g) g.push(c); else bySheet.set(c.sheetId, [c])
    }
    for (const sheetId of stashedSheetsRef.current) {
      if (!bySheet.has(sheetId)) stashPendingEdits(sheetId, [])
    }
    // Stash each edit under its EDIT-TIME generation (CellChange.generation) —
    // that's its provenance and what restore must compare against. Restamping
    // from the CURRENT ref here would launder a stale edit into the new
    // generation (the ref may have reseeded since the edit was made). The ref
    // is only the fallback for pre-seed edits (generation undefined).
    for (const [sheetId, edits] of bySheet) {
      const fallback = rowGenerationRef.current.get(sheetId) ?? 0
      stashPendingEdits(sheetId, edits.map(e => ({ ...e, rowGeneration: e.generation ?? fallback })))
    }
    stashedSheetsRef.current = new Set(bySheet.keys())
  }, [unsavedChanges, rowGenerationRef])

  // On sheet activation, re-hydrate any edits stashed for it (session expired
  // mid-edit last time). takeStashedEdits is read-once. Merge into the queue —
  // de-duping by (sheet,row,col) so a restored edit doesn't double an identical
  // live one — then the normal autosave flush re-sends them.
  useEffect(() => {
    if (!activeSheet) return
    const stashed = takeStashedEdits(activeSheet.id)
    if (stashed.length === 0) return
    // Only restore edits made under the SAME row_generation we just loaded. If the
    // sheet was sorted / CSV-replaced while the session was gone, the generation
    // bumped and a stale row_index now points at a different row — re-applying the
    // edit would overwrite the WRONG row. Drop those instead of silently corrupting.
    const currentGen = activeSheet.row_generation ?? 0
    const restored = stashed
      .filter(e => e.rowGeneration === currentGen)
      // Requeue WITH the generation: the filter above proves it equals the
      // freshly loaded one, so this preserves the edit-time stamp. Dropping it
      // (the old 4-field strip) requeued restored edits as generation:undefined,
      // which skips the server fence — bypassing edit-time stamping entirely
      // for the session-expiry path.
      .map(({ sheetId, rowIndex, columnName, value }) => ({ sheetId, rowIndex, columnName, value, generation: currentGen }))
    const discarded = stashed.length - restored.length
    if (restored.length > 0) {
      setUnsavedChanges(prev => {
        const dropped = new Set(restored.map(r => `${r.sheetId} ${r.rowIndex} ${r.columnName}`))
        const kept = prev.filter(p => !dropped.has(`${p.sheetId} ${p.rowIndex} ${p.columnName}`))
        return [...kept, ...restored]
      })
    }
    if (discarded > 0) {
      // The sheet changed structurally since these edits — restoring them could
      // hit the wrong rows, so we dropped them. Tell the user so they can redo.
      toast.error(
        `${discarded} unsaved edit${discarded > 1 ? 's' : ''} couldn't be restored: the sheet was reordered or re-imported since. Please re-enter.`,
        { id: 'edits-discarded' },
      )
    } else {
      toast('Restored unsaved edits from your last session.', { icon: '↩️', id: 'edits-restored' })
    }
  }, [activeSheet])
}
