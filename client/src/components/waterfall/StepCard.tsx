import React from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, FlaskConical, GripVertical, Trash2 } from 'lucide-react'
import type { ResultType } from '@/utils/api/waterfall'
import { Switch } from '@/components/enrich-modal/ProviderItem'
import type { DraftInput, DraftStep } from './draft'
import { KIND_LABEL, defaultNeeds, labelHint, stepSummary } from './step-copy'
import { RequiresField } from './RequiresField'
import { EnrichStepEditor } from './EnrichStepEditor'
import { AiStepEditor } from './AiStepEditor'
import { HttpStepEditor } from './HttpStepEditor'
import { FormulaField } from './FormulaField'
import { LookupStepEditor } from './LookupStepEditor'
import { CheckField } from './CheckField'

interface Props {
  sheetId: string
  step: DraftStep
  index: number
  count: number
  open: boolean
  inputs: DraftInput[]
  resultType: ResultType
  resultLabel: string
  dragOver: boolean
  onToggleOpen: () => void
  onChange: (step: DraftStep) => void
  onRemove: () => void
  onMove: (delta: -1 | 1) => void
  onTest?: () => void           // a dry run of this step alone (absent while the draft can't run)
  drag: { onDragStart: () => void; onDragOver: (e: React.DragEvent) => void; onDrop: () => void; onDragEnd: () => void }
}

// One step of the waterfall: its place (drag, or the arrows), its switch (off
// keeps it but skips it), its label (what "answered by" shows) and, opened,
// its setup and the inputs it needs.
export const StepCard: React.FC<Props> = (p) => {
  const { step, index, count, open, inputs } = p
  const c = step.choices
  return (
    // An open step holds text fields: dragging there selects text, so only a closed one drags.
    <li draggable={!open} onDragStart={p.drag.onDragStart} onDragOver={p.drag.onDragOver} onDrop={p.drag.onDrop}
      onDragEnd={p.drag.onDragEnd} data-testid="waterfall-step"
      className={`border border-gray-200 ${p.dragOver ? 'bg-gray-100' : 'bg-white'} ${step.on ? '' : 'opacity-70'}`}>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <GripVertical className="h-4 w-4 flex-shrink-0 text-gray-300 cursor-grab" aria-hidden="true" />
        <span className="text-xs text-gray-400 w-4 text-right">{index + 1}</span>
        <Switch on={step.on} label={`Use step ${index + 1}`} onClick={() => p.onChange({ ...step, on: !step.on })} />
        <button type="button" onClick={p.onToggleOpen} className="flex-1 min-w-0 text-left flex items-center gap-1">
          {open
            ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
            : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}
          <span className="min-w-0">
            <span className="block text-sm text-gray-900 truncate">
              {step.label || stepSummary(step)}
              <span className="ml-1.5 text-[10px] uppercase tracking-wide text-gray-400">{KIND_LABEL[c.kind]}</span>
            </span>
            {step.label && <span className="block text-xs text-gray-500 truncate">{stepSummary(step)}</span>}
          </span>
        </button>
        <button type="button" aria-label="Move up" disabled={index === 0} onClick={() => p.onMove(-1)}
          className="p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-30">
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label="Move down" disabled={index === count - 1} onClick={() => p.onMove(1)}
          className="p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-30">
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label="Remove step" onClick={p.onRemove}
          className="p-0.5 text-gray-400 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
      </div>
      {open && (
        <div className="border-t border-gray-100 px-3 py-2 space-y-3">
          <label className="block space-y-1">
            <span className="meta-label">Label (what &quot;answered by&quot; shows)</span>
            <input className="input w-full" value={step.label} placeholder={labelHint(step)} aria-label="Step label"
              maxLength={60} onChange={e => p.onChange({ ...step, label: e.target.value })} />
          </label>
          {c.kind === 'enrichment' && (
            <EnrichStepEditor choices={c} toolName={step.toolName} inputs={inputs} resultType={p.resultType}
              onChange={(choices, toolName) => p.onChange({ ...step, choices, ...(toolName ? { toolName } : {}) })} />
          )}
          {c.kind === 'ai' && (
            <AiStepEditor choices={c} inputs={inputs} resultLabel={p.resultLabel}
              onChange={choices => p.onChange({ ...step, choices })} />
          )}
          {c.kind === 'http' && (
            <HttpStepEditor choices={c} inputs={inputs} onChange={choices => p.onChange({ ...step, choices })} />
          )}
          {c.kind === 'formula' && (
            <FormulaField formula={c.formula} names={inputs.map(i => i.key)} label="Step formula"
              placeholder='{{first_name}}.toLowerCase() + "@" + {{domain}}'
              onChange={formula => p.onChange({ ...step, choices: { kind: 'formula', formula } })} />
          )}
          {c.kind === 'lookup' && (
            <LookupStepEditor sheetId={p.sheetId} choices={c} inputs={inputs} resultLabel={p.resultLabel}
              onChange={(choices, sheetName) => p.onChange({
                ...step, choices, ...(sheetName !== undefined ? { sheetName } : {}),
              })} />
          )}
          <RequiresField requires={step.requires} inputs={inputs} defaultText={defaultNeeds(step, inputs)}
            onChange={requires => p.onChange({ ...step, requires })} />
          <CheckField check={step.check} resultType={p.resultType} inputs={inputs}
            onChange={check => p.onChange({ ...step, check })} />
          {p.onTest && (
            <div className="flex justify-end">
              <button type="button" className="btn-secondary text-xs flex items-center gap-1" onClick={p.onTest}
                title="This step alone on a few rows, for real; nothing is written to the sheet">
                <FlaskConical className="h-3 w-3" /> Test this step
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  )
}
