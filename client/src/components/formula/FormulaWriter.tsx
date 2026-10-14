import React, { useEffect, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { formulaAPI, runConditionsAPI, type RuleModel, type WrittenFormula } from '@/utils/api'
import { formatCost } from '@/components/ai-modal/format'

interface Props {
  sheetId: string
  // The words a formula was written from before (Edit formula).
  initialWords: string | null
  onWritten: (out: WrittenFormula, words: string) => void
}

const SOURCE: Record<string, string> = {
  picked: 'the model you picked', sheet: "this sheet's default model", account: 'your default model',
}

// "Describe it": plain words, and "Write it with AI" turns them into a formula
// with one small call to the default model (the same one "Only run if" rules
// are written with). The formula then runs on every row with no AI.
export const FormulaWriter: React.FC<Props> = ({ sheetId, initialWords, onWritten }) => {
  const [words, setWords] = useState(initialWords ?? '')
  const [model, setModel] = useState<RuleModel | null>(null)
  const [writing, setWriting] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    runConditionsAPI.model(sheetId).then(m => { if (alive) setModel(m) }).catch(() => {})
    return () => { alive = false }
  }, [sheetId])

  const write = async () => {
    setWriting(true); setError(null); setNote(null)
    try {
      const out = await formulaAPI.write(sheetId, words)
      onWritten(out, words.trim())
      setNote(`Written by ${out.model}${out.cost_usd !== null ? ` for ${formatCost(out.cost_usd)}` : ''}. `
        + "Check the preview, and edit the formula if it isn't right.")
    } catch (e: any) {
      setError(e?.response?.data?.error ?? "Couldn't write the formula. Try again, or write it yourself below.")
    } finally {
      setWriting(false)
    }
  }

  return (
    <div className="space-y-2" data-testid="formula-writer">
      <label htmlFor="formula-words" className="block text-xs font-medium text-gray-700">Describe it</label>
      <textarea id="formula-words" className="input w-full text-sm" rows={2} value={words} maxLength={1000}
        onChange={e => setWords(e.target.value)}
        placeholder="What should this column hold? For example: the work email from Response" />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-secondary inline-flex items-center gap-1 text-xs"
          disabled={writing || !words.trim() || !model?.model} onClick={write} data-testid="formula-write">
          {writing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          Write it with AI
        </button>
        <span className="text-xs text-gray-500">
          {model === null ? '' : model.model
            ? `Uses ${model.model} (${SOURCE[model.source ?? 'account']}). Costs a fraction of a cent.`
            : 'No default AI model yet: pick one in Settings → AI, or write the formula yourself below.'}
        </span>
      </div>
      {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
      {note && <p className="text-xs text-gray-500">{note}</p>}
    </div>
  )
}
