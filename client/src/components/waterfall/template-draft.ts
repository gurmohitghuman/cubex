// A starter waterfall as the drawer's draft (pure): the template's result
// type, its inputs matched to the sheet's columns by name (as a new draft's
// are), and its steps with ids of their own, ready to change before running.
import type { WaterfallTemplateView } from '@/utils/api/waterfall'
import { guessColumn, newDraft, newStep, type WaterfallDraft } from './draft'

export function fromTemplate(t: WaterfallTemplateView, columns: string[]): WaterfallDraft {
  const d = newDraft(t.resultType, columns)
  return {
    ...d,
    inputs: t.inputs.map(i => {
      const col = guessColumn(i.key, columns)
      return { ...i, source: col ? { column: col } : null }
    }),
    steps: t.steps.map(s => ({
      ...newStep(s.choices), label: s.label ?? '', on: s.on, requires: s.requires,
      check: s.check ?? null,
    })),
  }
}
