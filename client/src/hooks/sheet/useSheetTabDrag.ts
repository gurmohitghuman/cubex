import { useState } from 'react'

// Drag-reorder state for the sheet tabs (native HTML5 DnD, pointer-only —
// matches column reorder; keyboard reorder is a deliberate non-goal).
//
// Gap-index model: dropGap g ∈ [0..n] means "insert into the gap BEFORE
// orderedIds[g]" (g === n → after the last tab). While dragging over a tab,
// the LEFT half targets the gap before it and the RIGHT half the gap after —
// Google-Sheets semantics. The old model (drop-on-tab always inserts before)
// made "move one slot right onto my neighbour" a silent no-op.

interface UseSheetTabDragArgs {
  orderedIds: string[]
  onReorder: (orderedIds: string[]) => void
}

export const useSheetTabDrag = ({ orderedIds, onReorder }: UseSheetTabDragArgs) => {
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropGap, setDropGap] = useState<number | null>(null)

  const clear = () => { setDragId(null); setDropGap(null) }

  const handleDragStart = (e: React.DragEvent, id: string) => {
    // Firefox refuses to start a drag unless dragstart calls setData.
    e.dataTransfer.setData('text/plain', id)
    e.dataTransfer.effectAllowed = 'move'
    setDragId(id)
  }

  // Attached to each tab WRAPPER (name button + chevron), so currentTarget's
  // rect spans the whole tab regardless of which child the pointer is over.
  const handleTabDragOver = (e: React.DragEvent, index: number) => {
    if (!dragId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    setDropGap(e.clientX < rect.left + rect.width / 2 ? index : index + 1)
  }

  // The trailing zone (right of the "+" button) always targets the end gap.
  const handleEndDragOver = (e: React.DragEvent) => {
    if (!dragId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropGap(orderedIds.length)
  }

  // Hide the caret when the pointer leaves the tab strip; relatedTarget is the
  // element being entered (null when leaving the window).
  const handleStripDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropGap(null)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    if (!dragId || dropGap === null) { clear(); return }
    // Clamp: orderedIds is read at drop time, so a mid-drag list change
    // (sheet deleted in another tab) can't push the gap out of range.
    const gap = Math.min(dropGap, orderedIds.length)
    const from = orderedIds.indexOf(dragId)
    const ids = orderedIds.filter(id => id !== dragId)
    ids.splice(gap > from ? gap - 1 : gap, 0, dragId)
    clear()
    if (ids.some((id, i) => id !== orderedIds[i])) onReorder(ids)
  }

  return {
    dragId, dropGap,
    handleDragStart, handleTabDragOver, handleEndDragOver, handleStripDragLeave,
    handleDrop, handleDragEnd: clear,
  }
}
