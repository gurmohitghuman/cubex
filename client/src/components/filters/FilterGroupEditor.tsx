import React from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { MAX_FILTER_PANEL_DEPTH, MAX_WHERE_CONDITIONS } from '@/lib/constants'
import { newGroup, newRule, type DraftGroup, type DraftNode } from '@/lib/filter-draft'
import { FilterRuleRow, type RuleContext } from './FilterRuleRow'

export interface GroupEdit {
  ctx: RuleContext
  // Replace node `id` (null removes it); apply: save now, else on commit.
  change: (id: number, next: DraftNode | null, apply: boolean) => void
  commit: () => void
  // Rules in the whole filter (adding stops at MAX_WHERE_CONDITIONS).
  rules: number
}

const JOIN_FIELD = 'text-xs border border-gray-300 rounded py-0.5 px-1 bg-white focus:outline-none '
  + 'focus:border-cube-black'

// The word before each item: "Where", then the group's join (a pick on the
// second item, as text after it).
const Lead: React.FC<{ index: number; group: DraftGroup; edit: GroupEdit }> = ({ index, group, edit }) => (
  <div className="w-14 flex-shrink-0 pt-1.5 text-xs text-gray-500 text-right pr-1">
    {index === 0 ? 'Where' : index === 1 ? (
      <select value={group.join} aria-label="Match all or any"
        onChange={e => edit.change(group.id, { ...group, join: e.target.value as 'and' | 'or' }, true)}
        className={JOIN_FIELD}>
        <option value="and">and</option>
        <option value="or">or</option>
      </select>
    ) : group.join}
  </div>
)

// A group's rules and groups. depth 0 is the panel's top level, which has no
// frame and no remove button of its own.
export const FilterGroupEditor: React.FC<{ group: DraftGroup; depth: number; edit: GroupEdit }> = (
  { group, depth, edit },
) => {
  const firstColumn = edit.ctx.columns[0] ?? ''
  const full = edit.rules >= MAX_WHERE_CONDITIONS
  const add = (node: DraftNode) => edit.change(group.id, { ...group, items: [...group.items, node] }, false)
  const body = (
    <div className="space-y-1.5">
      {group.items.map((node, index) => (
        <div key={node.id} className="flex items-start gap-1 min-w-0">
          <Lead index={index} group={group} edit={edit} />
          {node.kind === 'rule' ? (
            <FilterRuleRow rule={node} ctx={edit.ctx} commit={edit.commit}
              change={(rule, apply) => edit.change(node.id, rule, apply)}
              remove={() => edit.change(node.id, null, true)} />
          ) : (
            <FilterGroupEditor group={node} depth={depth + 1} edit={edit} />
          )}
        </div>
      ))}
      <div className={`flex items-center gap-3 ${group.items.length ? 'pl-[3.75rem]' : ''}`}>
        <button type="button" disabled={full} onClick={() => add(newRule(firstColumn))}
          className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900 disabled:opacity-40">
          <Plus className="h-3 w-3" /> Add rule
        </button>
        {depth < MAX_FILTER_PANEL_DEPTH && (
          <button type="button" disabled={full}
            onClick={() => add(newGroup(group.join === 'and' ? 'or' : 'and', firstColumn))}
            className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900 disabled:opacity-40">
            <Plus className="h-3 w-3" /> Add group
          </button>
        )}
      </div>
    </div>
  )
  if (depth === 0) return body
  return (
    <div className="flex-1 min-w-0 border border-gray-200 rounded-md bg-gray-50/60 p-2" data-testid="filter-group">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] text-gray-500">
          {group.join === 'and' ? 'All of these' : 'Any of these'}
        </span>
        <button type="button" onClick={() => edit.change(group.id, null, true)} aria-label="Remove this group"
          title="Remove this group" className="p-0.5 text-gray-400 hover:text-gray-800">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {body}
    </div>
  )
}
