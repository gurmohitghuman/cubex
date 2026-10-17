import { useMemo, useRef } from 'react'
import { buildColumnDefs } from './buildColumnDefs'

type Args = Parameters<typeof buildColumnDefs>[0]

// The grid's column defs, rebuilt only when something they show changes. AG Grid
// takes a new columnDefs array as a new def for EVERY column and force-refreshes
// every rendered cell, so rebuilding on each sheet render (each live result batch
// of a run, each run-list refetch) redrew the whole visible grid several times a
// second. The callbacks are read through a ref: parents pass some as inline arrows
// (a new function each render), and openColumnMenu changes with the row selection.
export function useColumnDefs(args: Args) {
  const latest = useRef(args)
  latest.current = args
  const calls = useMemo(() => ({
    onDeleteColumn: (column: string) => latest.current.onDeleteColumn?.(column),
    onAddColumn: () => latest.current.onAddColumn?.(),
    colIdFor: (name: string) => latest.current.colIdFor(name),
    handleHeaderColumnDelete: (column: string) => latest.current.handleHeaderColumnDelete(column),
    openColumnMenu: (column: string, anchor: DOMRect) => latest.current.openColumnMenu(column, anchor),
  }), [])
  const {
    columns, columnTypes, columnWidths, emptyFilter, columnFilters, autorun, columnSpend, cleanColumns,
    formulaColumns, hiddenColumns,
  } = args
  // buildColumnDefs only asks whether these exist (the header's × and the Add Column column).
  const canDelete = !!args.onDeleteColumn
  const canAdd = !!args.onAddColumn
  return useMemo(() => buildColumnDefs({
    ...calls, columns, columnTypes, columnWidths, emptyFilter, columnFilters, autorun, columnSpend, cleanColumns,
    formulaColumns, hiddenColumns,
    onDeleteColumn: canDelete ? calls.onDeleteColumn : undefined,
    onAddColumn: canAdd ? calls.onAddColumn : undefined,
  }), [calls, columns, columnTypes, columnWidths, emptyFilter, columnFilters, autorun, columnSpend, cleanColumns,
    formulaColumns, hiddenColumns, canDelete, canAdd])
}
