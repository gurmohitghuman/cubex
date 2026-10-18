import React from 'react'
import type { WhereItem } from '@/utils/api/views'
import { messageWithLabels } from '@/lib/filters'
import { changeNode, countRules, draftOf, whereOf, type DraftGroup, type DraftNode } from '@/lib/filter-draft'
import { FilterGroupEditor, type GroupEdit } from './FilterGroupEditor'
import type { RuleContext } from './FilterRuleRow'

// The filter panel: the active view's whole filter as rules and groups (any
// depth up to MAX_FILTER_PANEL_DEPTH), each rule with an on/off switch.
// Changes apply as they're made: a pick, a switch or a removal at once, typing
// on Enter or on leaving the field. A rule counts once it has a value. Each
// apply is one save and a reload of the rows (the grid is windowed, so
// filtering is server-side); the server keeps each column's first condition
// in its header (services/view-filter-save.ts).
export const FilterPanel: React.FC<{
  where: WhereItem[]
  ctx: RuleContext
  save: (where: WhereItem[] | null) => Promise<string | null>
}> = ({ where, ctx, save }) => {
  const [draft, setDraft] = React.useState<DraftGroup>(() => draftOf(where))
  const [problem, setProblem] = React.useState<string | null>(null)
  // The draft as of the last change (a commit right after a change reads it
  // before React renders), the filter last sent, and whether anything was
  // edited here: until then the panel follows the saved filter (a save still
  // landing when it opened, an agent or another tab changing it).
  const latest = React.useRef(draft)
  const sent = React.useRef(JSON.stringify(whereOf(draft)))
  const edited = React.useRef(false)
  const savedKey = JSON.stringify(where)
  React.useEffect(() => {
    if (edited.current) return
    const next = draftOf(JSON.parse(savedKey))
    latest.current = next
    sent.current = JSON.stringify(whereOf(next))
    setDraft(next)
  }, [savedKey])

  const apply = React.useCallback((next: DraftGroup) => {
    const out = whereOf(next)
    const key = JSON.stringify(out)
    if (key === sent.current) return
    const before = sent.current
    sent.current = key
    setProblem(null)
    void save(out.length ? out : null).then(failed => {
      if (!failed || sent.current !== key) return
      sent.current = before
      setProblem(failed)
    })
  }, [save])

  const edit: GroupEdit = {
    ctx,
    rules: countRules(draft),
    commit: () => apply(latest.current),
    change: (id, next: DraftNode | null, now) => {
      edited.current = true
      const tree = changeNode(latest.current, id, () => next)
      latest.current = tree
      setDraft(tree)
      if (now) apply(tree)
    },
  }
  const clearAll = () => {
    edited.current = true
    const empty: DraftGroup = { ...latest.current, items: [] }
    latest.current = empty
    setDraft(empty)
    apply(empty)
  }

  return (
    <div className="w-[min(680px,calc(100vw-32px))] p-3 space-y-2" data-testid="filter-panel">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-900">Filter rows</h3>
        {draft.items.length > 0 && (
          <button type="button" onClick={clearAll} className="text-xs text-gray-500 hover:text-gray-900">
            Clear all
          </button>
        )}
      </div>
      {draft.items.length === 0 && (
        <p className="text-xs text-gray-500">No filter: every row shows. Add a rule to show only some.</p>
      )}
      <FilterGroupEditor group={draft} depth={0} edit={edit} />
      <p className={`text-[11px] ${problem ? 'text-red-600' : 'text-gray-500'}`} role={problem ? 'alert' : undefined}>
        {problem ? `Not applied: ${messageWithLabels(problem)}`
          : 'Changes apply as you make them. A rule counts once it has a value; switch one off to see the rows '
            + 'without it.'}
      </p>
    </div>
  )
}
