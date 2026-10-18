import React, { useRef } from 'react'
import type { AiChoices } from '@/utils/api/waterfall'
import type { DraftInput } from './draft'

interface Props {
  choices: AiChoices
  inputs: DraftInput[]
  resultLabel: string
  onChange: (choices: AiChoices) => void
}

// An AI step: a prompt that reads the waterfall's inputs as /key words, asked
// for one value (or nothing when it can't find it), on a model (the sheet's
// or account's default unless one is named), with web search if wanted.
export const AiStepEditor: React.FC<Props> = ({ choices, inputs, resultLabel, onChange }) => {
  const box = useRef<HTMLTextAreaElement>(null)
  const insert = (key: string) => {
    const el = box.current
    const at = el ? el.selectionStart : choices.prompt.length
    const before = choices.prompt.slice(0, at)
    const gap = before && !/\s$/.test(before) ? ' ' : ''
    onChange({ ...choices, prompt: `${before}${gap}/${key} ${choices.prompt.slice(at)}` })
  }
  return (
    <div className="space-y-2" data-testid="waterfall-ai-step">
      <textarea ref={box} className="input w-full h-24 font-mono text-xs" value={choices.prompt}
        aria-label="AI prompt" placeholder={`Find the ${resultLabel.toLowerCase()} of /full_name at /domain`}
        onChange={e => onChange({ ...choices, prompt: e.target.value })} />
      <div className="flex flex-wrap gap-1">
        {inputs.map(i => (
          <button key={i.key} type="button" onClick={() => insert(i.key)}
            className="px-1.5 py-0.5 text-[11px] border border-gray-300 text-gray-600 hover:border-gray-500">
            /{i.key}
          </button>
        ))}
      </div>
      <p className="text-xs text-gray-500">
        It answers with one {resultLabel.toLowerCase()}, or nothing when it can&apos;t find one; an answer that
        isn&apos;t one counts as nothing and the next step runs.
      </p>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
        <label className="text-xs text-gray-600" htmlFor="wf-ai-model">Model</label>
        <input id="wf-ai-model" className="input w-full" value={choices.model ?? ''} placeholder="Your default model"
          onChange={e => onChange({ ...choices, model: e.target.value.trim() || null })} />
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={choices.webSearch}
          onChange={e => onChange({ ...choices, webSearch: e.target.checked })} />
        Search the web (each search costs a little more)
      </label>
    </div>
  )
}
