import React from 'react'
import { changeNode, countRules, type DraftGroup, type DraftNode } from '@/lib/filter-draft'
import { FilterGroupEditor, type GroupEdit } from '../filters/FilterGroupEditor'
import type { RuleContext } from '../filters/FilterRuleRow'

// Auto-delete's rules (mode rules): the filter panel's rule editor on a draft of its own, saved with the rest of the
// form (nothing is applied as it is typed, unlike the sheet's filter).
export function WebhookAutoDeleteRules({ draft, onDraft, ctx }: {
  draft: DraftGroup
  onDraft: (next: DraftGroup) => void
  ctx: RuleContext
}) {
  const latest = React.useRef(draft)
  latest.current = draft
  const edit: GroupEdit = {
    ctx,
    rules: countRules(draft),
    commit: () => {},
    change: (id, next: DraftNode | null) => onDraft(changeNode(latest.current, id, () => next)),
  }
  return (
    <div className="rounded border border-gray-200 p-2" data-testid="webhook-auto-delete-rules">
      {draft.items.length === 0 && (
        <p className="pb-1.5 text-gray-500">Add a rule: rows that match the rules are deleted.</p>
      )}
      <FilterGroupEditor group={draft} depth={0} edit={edit} />
    </div>
  )
}
