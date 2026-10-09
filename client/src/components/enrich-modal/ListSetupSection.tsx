import React, { useEffect } from 'react'
import type { EnrichToolDetail } from '@/utils/api'
import { AccordionSection } from '../AccordionSection'
import { mergePicks, type ListDraft, type SheetRef } from './list-draft'
import { ListRowsPane, listSummary } from './ListRowsPane'
import { useListFields } from './useListFields'

interface Props {
  sheetId: string
  tool: EnrichToolDetail
  list: ListDraft
  updateList: (patch: Partial<ListDraft>) => void
  columns: string[]
  sheets: SheetRef[] | null
  sent: Set<string>
  destProblem: string | null
  // The column a run already made (Edit, Back to setup): its results offer the fields.
  column: string | null
  active: boolean
}

// Set up's "Add results as rows" (U8), in place of Outputs. On a column that
// already has results, the fields to keep come from them (joined into the
// picks so far, so ticks and names stay).
export const ListSetupSection: React.FC<Props> = (p) => {
  const { choices } = useListFields(p.sheetId, p.column, p.active, '')
  useEffect(() => {
    if (!choices || choices.fields.length === 0) return
    p.updateList({ fields: mergePicks(p.list.fields, choices.fields, choices.kept, p.list.copy) })
  }, [choices]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AccordionSection title="Add results as rows" summary={listSummary(p.list, p.sheets)} defaultOpen>
      <ListRowsPane tool={p.tool} list={p.list} update={p.updateList} columns={p.columns} sheets={p.sheets}
        sent={p.sent} destProblem={p.destProblem} fieldsFrom={choices?.results ?? null} />
    </AccordionSection>
  )
}
