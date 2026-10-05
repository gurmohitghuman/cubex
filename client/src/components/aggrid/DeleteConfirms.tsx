import React from 'react'
import { ConfirmDialog } from '../ConfirmDialog'

interface Props {
  confirmDeleteColumn: string | null
  setConfirmDeleteColumn: (v: string | null) => void
  confirmDeleteRows: number[] | null
  setConfirmDeleteRows: (v: number[] | null) => void
  // Clears the grid row selection through AG Grid (deselectAll), which un-highlights
  // the rows AND syncs both React mirrors. Replaces the old setSelectedRows([]),
  // which only poked one mirror and left rows visually selected.
  clearRowSelection: () => void
  onDeleteColumn?: (columnName: string) => void | Promise<void>
  onDeleteRows?: (rowIndexes: number[]) => void | Promise<void>
}

export const DeleteConfirms: React.FC<Props> = ({
  confirmDeleteColumn, setConfirmDeleteColumn,
  confirmDeleteRows, setConfirmDeleteRows,
  clearRowSelection, onDeleteColumn, onDeleteRows,
}) => (
  <>
    <ConfirmDialog
      isOpen={!!confirmDeleteColumn}
      title="Delete Column"
      message={`Are you sure you want to delete column "${confirmDeleteColumn || ''}"?`}
      confirmText="Delete" isDestructive
      onConfirm={async () => {
        if (confirmDeleteColumn && onDeleteColumn) await onDeleteColumn(confirmDeleteColumn)
        setConfirmDeleteColumn(null)
      }}
      onCancel={() => setConfirmDeleteColumn(null)}
    />
    <ConfirmDialog
      isOpen={!!confirmDeleteRows}
      title="Delete Rows"
      message={`Are you sure you want to delete ${confirmDeleteRows?.length || 0} selected row(s)?`}
      confirmText="Delete" isDestructive
      onConfirm={() => {
        // Close the dialog + clear selection IMMEDIATELY, then run the delete
        // fire-and-forget. The old code awaited onDeleteRows before closing, so
        // the popup hung until the whole flush+delete round-trip finished.
        // handleDeleteRows takes explicit indices (doesn't read selection) and
        // owns all progress/outcome feedback via its own "Deleting…" toast.
        const rows = confirmDeleteRows
        setConfirmDeleteRows(null)
        clearRowSelection()
        if (rows && onDeleteRows && rows.length > 0) void onDeleteRows(rows)
      }}
      onCancel={() => setConfirmDeleteRows(null)}
    />
  </>
)
