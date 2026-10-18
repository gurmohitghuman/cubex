import React, { useState } from 'react'
import { Bot, DatabaseZap, FunctionSquare, Globe, TableProperties } from 'lucide-react'
import type { ResultType, StepKind } from '@/utils/api/waterfall'
import { emptyChoices, moveStep, newStep, type DraftInput, type DraftStep } from './draft'
import { StepCard } from './StepCard'

interface Props {
  sheetId: string
  steps: DraftStep[]
  inputs: DraftInput[]
  resultType: ResultType
  resultLabel: string
  onChange: (steps: DraftStep[]) => void
  onTest?: (stepId: string) => void
}

// The steps in order: each row tries them top to bottom and stops at the
// first answer. Drag a step (or use its arrows) to reorder, switch one off to
// skip it. A new step opens for its setup.
export const StepsSection: React.FC<Props> = (
  { sheetId, steps, inputs, resultType, resultLabel, onChange, onTest },
) => {
  const [open, setOpen] = useState<string | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const add = (kind: StepKind) => {
    const s = newStep(emptyChoices(kind))
    onChange([...steps, s])
    setOpen(s.key)
  }
  const set = (i: number, s: DraftStep) => onChange(steps.map((x, k) => (k === i ? s : x)))
  return (
    <div className="space-y-2" data-testid="waterfall-steps">
      {steps.length === 0 && (
        <p className="text-xs text-gray-500">Add the places to look, cheapest or most likely first.</p>
      )}
      <ol className="space-y-1">
        {steps.map((s, i) => (
          <StepCard key={s.key} sheetId={sheetId} step={s} index={i} count={steps.length} open={open === s.key}
            inputs={inputs} resultType={resultType} resultLabel={resultLabel} dragOver={over === i && dragging !== i}
            onToggleOpen={() => setOpen(open === s.key ? null : s.key)} onChange={next => set(i, next)}
            onRemove={() => onChange(steps.filter((_, k) => k !== i))}
            onMove={d => onChange(moveStep(steps, i, i + d))}
            onTest={onTest && s.id ? () => onTest(s.id!) : undefined}
            drag={{
              onDragStart: () => setDragging(i),
              onDragOver: e => { e.preventDefault(); setOver(i) },
              onDrop: () => {
                if (dragging !== null) onChange(moveStep(steps, dragging, i))
                setDragging(null); setOver(null)
              },
              onDragEnd: () => { setDragging(null); setOver(null) },
            }} />
        ))}
      </ol>
      <div className="flex flex-wrap gap-1">
        <button type="button" className="btn-secondary flex items-center gap-1" onClick={() => add('enrichment')}>
          <DatabaseZap className="h-3 w-3" /> Enrichment tool
        </button>
        <button type="button" className="btn-secondary flex items-center gap-1" onClick={() => add('ai')}>
          <Bot className="h-3 w-3" /> AI prompt
        </button>
        <button type="button" className="btn-secondary flex items-center gap-1" onClick={() => add('http')}>
          <Globe className="h-3 w-3" /> HTTP API
        </button>
        <button type="button" className="btn-secondary flex items-center gap-1" onClick={() => add('formula')}
          title="Free: JavaScript over the inputs, such as a guess at an address">
          <FunctionSquare className="h-3 w-3" /> Formula
        </button>
        <button type="button" className="btn-secondary flex items-center gap-1" onClick={() => add('lookup')}
          title="Free: the value from another sheet's matching row">
          <TableProperties className="h-3 w-3" /> Lookup
        </button>
      </div>
    </div>
  )
}
