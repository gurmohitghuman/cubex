// A plain JavaScript reading of a `where` (lib/row-filter/where.ts), built
// from the same operator and cell-status code "Only run if" and include_status
// use. The SQL lib/row-filter/sql.ts compiles must pass exactly the rows this
// passes: the tests run both over the same cells.
import opsMod from '../../server/src/lib/row-filter/ops'
import datesMod from '../../server/src/lib/row-filter/dates'
import statusMod from '../../server/src/lib/row-filter/cell-status'
import type { FilterCondition, WhereItem } from '../../server/src/lib/row-filter/where'
const {
  asNumber, datePasses, foldText, isDateOp, isListOp, isNumberOp, isStateOp, listPasses, numberPasses, textPasses,
} = opsMod as typeof import('../../server/src/lib/row-filter/ops')
const { asDate } = datesMod as typeof import('../../server/src/lib/row-filter/dates')
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
  if (isDateOp(op)) return datePasses(op, asDate(cell), asDate(c.value))
  if (isListOp(op)) return listPasses(op, foldText(cell), (c.values ?? []).map(foldText))
  return textPasses(op, foldText(cell), foldText(c.value))
}

// An off condition counts for nothing: an AND list or group skips it, and a
// group with nothing on counts for nothing in its parent (written out here
// directly, not through activeWhere, so the SQL's pruning is checked too).
type Verdict = boolean | null
function verdict(item: WhereItem, data: Record<string, unknown>, runColumns: ReadonlyMap<string, string>): Verdict {
  if ('or' in item || 'and' in item) {
    const items = ('or' in item ? item.or : item.and).map(i => verdict(i, data, runColumns))
      .filter((v): v is boolean => v !== null)
    if (items.length === 0) return null
    return 'or' in item ? items.some(Boolean) : items.every(Boolean)
  }
  return item.enabled === false ? null : passes(item, data, runColumns)
}

export function referencePasses(
  where: readonly WhereItem[], data: Record<string, unknown>, runColumns: ReadonlyMap<string, string> = new Map(),
): boolean {
  return verdict({ and: [...where] }, data, runColumns) !== false
}
