import React, { useEffect, useState } from 'react'
import { waterfallAPI, type ResultType, type WaterfallTemplateView } from '@/utils/api/waterfall'
import { RESULT_OPTIONS, newDraft, type WaterfallDraft } from './draft'
import { fromTemplate } from './template-draft'

interface Props {
  columns: string[]
  error: string | null
  onPick: (draft: WaterfallDraft) => void
}

// A new waterfall's first screen: what it finds, or a starter waterfall with
// its steps set up (inputs matched to the columns by name), to change before
// running. The starters load from the server (at once: they're fixed); without them the types still show.
export const StartPicker: React.FC<Props> = ({ columns, error, onPick }) => {
  const [templates, setTemplates] = useState<WaterfallTemplateView[]>([])
  useEffect(() => {
    let live = true
    waterfallAPI.templates().then(t => { if (live) setTemplates(t) }).catch(() => {})
    return () => { live = false }
  }, [])
  const option = 'w-full text-left border border-gray-200 px-3 py-2 hover:border-gray-400'
  return (
    <div className="p-4 space-y-4" data-testid="waterfall-result-types">
      {templates.length > 0 && (
        <div className="space-y-2" data-testid="waterfall-templates">
          <p className="text-sm text-gray-700">Start from a template</p>
          {templates.map(t => (
            <button key={t.id} type="button" className={option} data-testid={`waterfall-template-${t.id}`}
              onClick={() => onPick(fromTemplate(t, columns))}>
              <span className="text-sm text-gray-900">{t.title}</span>
              <span className="block text-xs text-gray-500">{t.description}</span>
            </button>
          ))}
        </div>
      )}
      <div className="space-y-2">
        <p className="text-sm text-gray-700">
          {templates.length > 0 ? 'Or pick what it finds' : 'What should it find?'}
        </p>
        {RESULT_OPTIONS.map(o => (
          <button key={o.type} type="button" className={option} data-testid={`waterfall-type-${o.type}`}
            onClick={() => onPick(newDraft(o.type as ResultType, columns))}>
            <span className="text-sm text-gray-900">{o.label}</span>
            <span className="block text-xs text-gray-500">{o.hint}</span>
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}
