// The filter panel's draft (pure): the active view's `where` as a tree the
// panel edits (components/views/FilterPanel.tsx), and back. The top level is a
// group too: "all" is the `where` list itself, "any" one OR group around it.
// A rule still missing its value isn't part of the `where` until it has one.
import type { WhereCondition, WhereItem } from '@/utils/api/views'
import { isRunStateFilter, isListFilter, type FilterOp } from './filters'
import { isGroupItem, itemsOf } from './views'

export interface DraftRule {
  kind: 'rule'
  id: number
  // '' with a run-state operator: any AI, HTTP API or enrichment column.
  column: string
  op: FilterOp
  value: string
  values: string[]
  enabled: boolean
}
export interface DraftGroup { kind: 'group'; id: number; join: 'and' | 'or'; items: DraftNode[] }
export type DraftNode = DraftRule | DraftGroup

let lastId = 0
const nextId = () => ++lastId

export const newRule = (column: string): DraftRule =>
  ({ kind: 'rule', id: nextId(), column, op: 'contains', value: '', values: [], enabled: true })
export const newGroup = (join: 'and' | 'or', column: string): DraftGroup =>
  ({ kind: 'group', id: nextId(), join, items: [newRule(column)] })

function nodeOf(item: WhereItem): DraftNode {
  if (isGroupItem(item)) {
    return { kind: 'group', id: nextId(), join: 'or' in item ? 'or' : 'and', items: itemsOf(item).map(nodeOf) }
  }
  return {
    kind: 'rule', id: nextId(), column: item.column ?? '', op: item.operator,
    value: item.value ?? '', values: item.values ?? [], enabled: item.enabled !== false,
  }
}

export function draftOf(where: readonly WhereItem[]): DraftGroup {
  if (where.length === 1 && 'or' in where[0]) return nodeOf(where[0]) as DraftGroup
  return { kind: 'group', id: nextId(), join: 'and', items: where.map(nodeOf) }
}

// The rule as a condition, or null while it is missing what it needs.
export function ruleCondition(r: DraftRule): WhereCondition | null {
  const off = r.enabled ? {} : { enabled: false as const }
  if (isRunStateFilter(r.op)) return { ...(r.column ? { column: r.column } : {}), operator: r.op, ...off }
  if (!r.column) return null
  if (r.op === 'empty' || r.op === 'not_empty') return { column: r.column, operator: r.op, ...off }
  if (isListFilter(r.op)) return r.values.length ? { column: r.column, operator: r.op, values: r.values, ...off } : null
  return r.value.trim() ? { column: r.column, operator: r.op, value: r.value.trim(), ...off } : null
}

function itemOf(node: DraftNode): WhereItem | null {
  if (node.kind === 'rule') return ruleCondition(node)
  const items = node.items.map(itemOf).filter((i): i is WhereItem => i !== null)
  if (items.length === 0) return null
  return node.join === 'or' ? { or: items } : { and: items }
}

export function whereOf(root: DraftGroup): WhereItem[] {
  const items = root.items.map(itemOf).filter((i): i is WhereItem => i !== null)
  return root.join === 'or' && items.length > 1 ? [{ or: items }] : items
}

// The tree with node `id` replaced by what `change` returns (null removes it).
export function changeNode(root: DraftGroup, id: number, change: (n: DraftNode) => DraftNode | null): DraftGroup {
  const walk = (node: DraftNode): DraftNode | null => {
    if (node.id === id) return change(node)
    if (node.kind === 'rule') return node
    return { ...node, items: node.items.map(walk).filter((n): n is DraftNode => n !== null) }
  }
  return walk(root) as DraftGroup
}

export const countRules = (node: DraftNode): number =>
  (node.kind === 'rule' ? 1 : node.items.reduce((n, i) => n + countRules(i), 0))
