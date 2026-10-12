import React, { useEffect, useState } from 'react'
import { Loader2, Plus, Sparkles } from 'lucide-react'
import { runConditionsAPI, type RuleModel } from '@/utils/api'
import { formatCost } from '@/components/ai-modal/format'
import { useRuleCheck } from './useRuleCheck'
import { RuleSample } from './RuleSample'

interface Props {
  sheetId: string
  // The rule as text ('' = every row runs).
  value: string
  onChange: (rule: string) => void
  // The drawer or dialog is open: read the model and check the rule only then.
  active: boolean
  // What a row that fails the rule does here ("is skipped" for a run, "waits" for auto-run).
  skippedNote?: string
  // Inside a section already titled "Only run if" (the AI and HTTP drawers).
  untitled?: boolean
}

const SOURCE: Record<string, string> = {
  picked: 'the model you picked', sheet: "this sheet's default model", account: 'your default model',
}

// "Only run if" for AI, HTTP API and enrichment columns and auto-run: say in
// plain words which rows should run and "Write the rule" turns it into a rule
// with one small call to the default model, or write the rule yourself. Cubex
// then checks every row against the rule without AI.
export const RunIfField: React.FC<Props> = ({ sheetId, value, onChange, active, skippedNote, untitled }) => {
  const title = untitled ? null : <p className="text-sm font-medium text-gray-700">Only run if</p>
  const [open, setOpen] = useState(value.trim() !== '')
  const [words, setWords] = useState('')
  const [model, setModel] = useState<RuleModel | null>(null)
  const [writing, setWriting] = useState(false)
  const [written, setWritten] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)
  const check = useRuleCheck(sheetId, value, active && open)

  useEffect(() => { if (value.trim()) setOpen(true) }, [value])
  useEffect(() => {
    if (!active || !open) return
    let alive = true
    runConditionsAPI.model(sheetId).then(m => { if (alive) setModel(m) }).catch(() => {})
    return () => { alive = false }
  }, [sheetId, active, open])

  const write = async () => {
    setWriting(true); setWriteError(null); setWritten(null)
    try {
      const out = await runConditionsAPI.generate(sheetId, words)
      onChange(out.check.rule)
      setWritten(`Written by ${out.model}${out.cost_usd !== null ? ` for ${formatCost(out.cost_usd)}` : ''}.`)
    } catch (e: any) {
      setWriteError(e?.response?.data?.error ?? "Couldn't write the rule. Try again, or write it yourself below.")
    } finally {
      setWriting(false)
    }
  }

  if (!open) {
    return (
      <div className="space-y-1" data-testid="run-if">
        {title}
        <button type="button" onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 text-xs text-gray-700 hover:text-cube-black">
          <Plus className="h-3.5 w-3.5" />Add a rule
        </button>
        <p className="text-xs text-gray-500">Every row runs.</p>
      </div>
    )
  }

  return (
    <div className="space-y-2" data-testid="run-if">
      <div className="flex items-center justify-between">
        {title ?? <span />}
        <button type="button" className="text-xs text-gray-500 hover:text-cube-black"
          onClick={() => { onChange(''); setWords(''); setWritten(null); setWriteError(null); setOpen(false) }}>
          Remove
        </button>
      </div>
      <textarea className="input w-full text-sm" rows={2} value={words} onChange={e => setWords(e.target.value)}
        aria-label="Which rows should run" maxLength={1000}
        placeholder="Which rows should run? For example: industry is SaaS or Fintech, and more than 50 employees" />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-secondary inline-flex items-center gap-1 text-xs"
          disabled={writing || !words.trim() || !model?.model} onClick={write}>
          {writing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          Write the rule
        </button>
        <span className="text-xs text-gray-500" data-testid="run-if-model">
          {model === null ? '' : model.model
            ? `Uses ${model.model} (${SOURCE[model.source ?? 'account']}). Costs a fraction of a cent.`
            : 'No default AI model yet: pick one in Settings → AI, or write the rule yourself below.'}
        </span>
      </div>
      {writeError && <p className="text-xs text-red-600">{writeError}</p>}

      <label className="block space-y-1">
        <span className="text-xs font-medium text-gray-700">Rule</span>
        <textarea className="input w-full font-mono text-xs" rows={2} value={value} spellCheck={false}
          onChange={e => { onChange(e.target.value); setWritten(null) }} aria-label="Rule"
          placeholder={'{{Industry}} is "SaaS" AND {{Employees}} > 50'} />
      </label>
      {written && <p className="text-xs text-gray-500">{written} Check it, and edit it if it isn&apos;t right.</p>}
      {check.state === 'checking' && <p className="text-xs text-gray-500">Checking the rule…</p>}
      {check.state === 'error' && <p className="text-xs text-red-600" data-testid="run-if-error">{check.error}</p>}
      {check.state === 'ok' && <RuleSample check={check.check} />}
      <p className="text-xs text-gray-500">
        {skippedNote ?? 'Rows that don\'t pass are skipped, cost nothing, and show "⏭️ Condition not met".'}
        {' '}Use is, is not, contains, is empty, &gt;, &lt;, with AND, OR, NOT and brackets.
      </p>
    </div>
  )
}
