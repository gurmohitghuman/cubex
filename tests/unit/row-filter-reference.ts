// A plain JavaScript reading of a `where` (lib/row-filter/where.ts), built
// from the same operator and cell-status code "Only run if" and include_status
// use. The SQL lib/row-filter/sql.ts compiles must pass exactly the rows this
// passes: the tests run both over the same cells.
import opsMod from '../../server/src/lib/row-filter/ops'
import statusMod from '../../server/src/lib/row-filter/cell-status'
import type { FilterCondition, WhereItem } from '../../server/src/lib/row-filter/where'
const { asNumber, foldText, isListOp, isNumberOp, isStateOp, listPasses, numberPasses, textPasses } =
  opsMod as typeof import('../../server/src/lib/row-filter/ops')
const { cellStatus } = statusMod as typeof import('../../server/src/lib/row-filter/cell-status')

const STATE_FOR = { has_error: 'error', has_result: 'done', not_run: 'not_run',
  condition_not_met: 'condition_not_met', running: 'running' } as const

const cellOf = (data: Record<string, unknown>, column: string): unknown =>
  Object.prototype.hasOwnProperty.call(data, column) ? data[column] ?? '' : ''

function passes(c: FilterCondition, data: Record<string, unknown>, runColumns: ReadonlyMap<string, string>): boolean {
  const op = c.operator
  if (isStateOp(op)) {
    const columns = c.column !== undefined ? [c.column] : [...runColumns.keys()]
    return columns.some(col => {
      const state = runColumns.get(col)
      const stateCell = state !== undefined && state !== col ? cellOf(data, state) : ''
      return cellStatus(cellOf(data, col), stateCell) === STATE_FOR[op]
    })
  }
  const cell = cellOf(data, c.column!)
  if (isNumberOp(op)) return numberPasses(op, asNumber(cell), asNumber(c.value))
  if (isListOp(op)) return listPasses(op, foldText(cell), (c.values ?? []).map(foldText))
  return textPasses(op, foldText(cell), foldText(c.value))
}

export function referencePasses(
  where: readonly WhereItem[], data: Record<string, unknown>, runColumns: ReadonlyMap<string, string> = new Map(),
): boolean {
  return where.every(item => ('or' in item
    ? item.or.some(c => passes(c, data, runColumns))
    : passes(item, data, runColumns)))
}
