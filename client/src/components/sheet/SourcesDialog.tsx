// The sources a "(Data)" cell's AI run read, in a dialog (components/ScrapedDataModal.tsx). Its state lives here,
// not in SheetPage, so opening it re-renders the dialog only, never the page or the grid (as CellPanels does for
// the side panels). SheetPage hands each click over through the handle.
import React, { forwardRef, useImperativeHandle, useState } from 'react'
import { ScrapedDataModal, type SourcesCell } from '@/components/ScrapedDataModal'

export interface SourcesDialogHandle { open: (cell: SourcesCell) => void }

export const SourcesDialog = forwardRef<SourcesDialogHandle>(function SourcesDialog(_props, ref) {
  const [shown, setShown] = useState<{ isOpen: boolean; cell: SourcesCell | null }>({ isOpen: false, cell: null })
  useImperativeHandle(ref, () => ({ open: cell => setShown({ isOpen: true, cell }) }), [])
  return (
    <ScrapedDataModal isOpen={shown.isOpen} cell={shown.cell} onClose={() => setShown({ isOpen: false, cell: null })} />
  )
})
