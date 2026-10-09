import React, { useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { enrichAPI, type Sheet } from '@/utils/api'
import { plural } from '@/lib/utils'

interface Props {
  sheet: Sheet | null
  onConfirm: (sheet: Sheet) => void
  onCancel: () => void
}

const names = (list: string[]) =>
  list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`

// Deleting a sheet tab. Results its enrichments bought that aren't rows in
// another sheet yet (being added, waiting for room or for fields) go with it,
// so the confirm says how many and where.
export const DeleteSheetConfirm: React.FC<Props> = ({ sheet, onConfirm, onCancel }) => {
  const [note, setNote] = useState('')
  useEffect(() => {
    setNote('')
    if (!sheet) return
    let alive = true
    enrichAPI.resultsNotAdded(sheet.id)
      .then(r => {
        if (!alive || !r) return
        const verb = r.results === 1 ? "hasn't" : "haven't"
        setNote(` ${plural(r.results, 'result')} from it ${verb} been added to ${names(r.sheets)} yet. `
          + 'Deleting the sheet drops them.')
      })
      .catch(() => { /* the plain confirm still stands */ })
    return () => { alive = false }
  }, [sheet])

  return (
    <ConfirmDialog
      isOpen={!!sheet}
      title="Delete Sheet"
      message={`Delete "${sheet?.name}" and all its data? This cannot be undone.${note}`}
      confirmText="Delete Sheet"
      onConfirm={() => { if (sheet) onConfirm(sheet) }}
      onCancel={onCancel}
      isDestructive
    />
  )
}
