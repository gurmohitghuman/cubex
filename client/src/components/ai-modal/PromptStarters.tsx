import React, { useMemo, useRef } from 'react'
import { promptStarters, type PromptStarter, type SheetColumnRef } from '@/lib/prompt-starters'
import type { OutputColumnDraft } from '@/lib/output-columns'

interface Props {
  columns: SheetColumnRef[]
  prompt: string
  setPrompt: (v: string) => void
  columnName: string
  setColumnName: (v: string) => void
  outputColumns: OutputColumnDraft[]
  setOutputColumns: (v: OutputColumnDraft[]) => void
}

const same = (a: OutputColumnDraft[], b: OutputColumnDraft[]) => JSON.stringify(a) === JSON.stringify(b)

// "Start from": a good first prompt for the usual jobs, written with this
// sheet's columns (lib/prompt-starters.ts). Shown while the prompt is empty or
// still the one a starter wrote, so it never replaces words the person typed.
// Picking another one also replaces the name and output columns the last one
// filled in, and keeps any the person changed.
export const PromptStarters: React.FC<Props> = (p) => {
  const starters = useMemo(() => promptStarters(p.columns), [p.columns])
  const applied = useRef<PromptStarter | null>(null)
  const last = applied.current
  if (p.prompt.trim() && p.prompt !== last?.prompt) return null

  const apply = (s: PromptStarter) => {
    p.setPrompt(s.prompt)
    if (!p.columnName.trim() || p.columnName === last?.columnName) p.setColumnName(s.columnName)
    if (p.outputColumns.length === 0 || (last && same(p.outputColumns, last.outputColumns))) {
      p.setOutputColumns(s.outputColumns)
    }
    applied.current = s
  }

  return (
    <div className="mb-2" data-testid="prompt-starters">
      <p className="text-xs text-gray-500 mb-1">Start from:</p>
      <div className="flex flex-wrap gap-1">
        {starters.map(s => (
          <button key={s.id} type="button" onClick={() => apply(s)} title={s.hint}
            className={'px-2 py-1 text-xs border rounded-md transition-colors '
              + (last?.id === s.id && p.prompt === last.prompt
                ? 'border-cube-black bg-cube-black text-white'
                : 'border-gray-300 text-gray-700 hover:border-gray-500')}>
            {s.label}
          </button>
        ))}
      </div>
    </div>
  )
}
