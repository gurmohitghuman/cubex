import React, { useEffect, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import toast from 'react-hot-toast'
import { httpAPI, sheetsAPI, settingsAPI } from '@/utils/api'
import { SavedKeysPicker } from './SavedKeysPicker'
import { OpenRouterCreditNotice } from '../OpenRouterCreditNotice'
import { NoModelNotice } from '../NoModelNotice'
import { HTTPAPIConfig } from './types'

interface Props {
  sheetId: string
  // The sheet's saved AI model — feeds the "no model" banner (sheet default >
  // account default, the same chain the server enforces with a 400).
  sheetDefaultModel?: string | null
  // Called with a freshly AI-generated config + a connection-name hint. The
  // parent merges these into its existing `config` state so the visible
  // fields below this bar populate immediately.
  onAutoFill: (config: HTTPAPIConfig, connectionName?: string) => void
}

// Top-of-modal "AI assist" bar. The user types a goal, optionally pastes the
// docs URL and an API key, hits Auto-fill, and the AI populates the same
// visible HTTP-config fields a manual user would fill below. Replaces the old
// AI/Manual tab split: one screen, AI as an assist on top of the regular form.
export const AIAssistBar: React.FC<Props> = ({ sheetId, sheetDefaultModel, onAutoFill }) => {
  const [goal, setGoal] = useState('')
  const [docsUrl, setDocsUrl] = useState('')
  const [keyedColumn, setKeyedColumn] = useState('')
  const [columns, setColumns] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  // Inline (not a toast): generation failures — e.g. "No AI model set" — need
  // to stay on screen next to the control they block, not vanish after 4s.
  const [error, setError] = useState<string | null>(null)

  // Saved-key picker state. The same picker is used by the legacy SavedKeysPicker
  // so the user can either select an already-stored key OR paste an inline one
  // (and optionally save it for next time).
  const [selectedKeyName, setSelectedKeyName] = useState('')
  const [inlineKey, setInlineKey] = useState('')
  const [saveInline, setSaveInline] = useState(false)
  const [inlineKeyName, setInlineKeyName] = useState('')

  useEffect(() => {
    sheetsAPI.getColumns(sheetId)
      .then(cols => setColumns(cols.map(c => c.name)))
      .catch(() => setColumns([]))
  }, [sheetId])

  // Same logic as the previous AIGenerateTab — resolve the user's key to either
  // a `/savedName` token (substituted server-side at run time, redacted at rest)
  // or the literal value they pasted.
  const resolveApiKeyValue = async (): Promise<string | null> => {
    if (selectedKeyName) return `/${selectedKeyName}`
    const raw = inlineKey.trim()
    if (!raw) return null
    if (saveInline && inlineKeyName.trim()) {
      try {
        const created = await settingsAPI.createAPIKey({
          name: inlineKeyName.trim(), key_type: 'bearer', key_value: raw,
        })
        toast.success(`Saved "${created.name}" for next time`)
        return `/${created.name}`
      } catch (e: any) {
        toast.error(e?.response?.data?.error || 'Could not save the key (using inline)')
        return raw
      }
    }
    return raw
  }

  // Replace whatever Authorization header the AI generated with one wired to
  // the user's actual key. The AI typically returns `Bearer YOUR_API_KEY` as a
  // placeholder — without this, every preview 401s.
  const wireAuthHeader = (config: HTTPAPIConfig, value: string): HTTPAPIConfig => {
    const headers = (config.headers ?? []).filter(h => h.key.toLowerCase() !== 'authorization')
    headers.push({ key: 'Authorization', value: `Bearer ${value}` })
    return { ...config, headers }
  }

  const handleAutoFill = async () => {
    if (!goal.trim()) { setError('Tell us what to look up first.'); return }
    setLoading(true)
    setError(null)
    try {
      const keyValue = await resolveApiKeyValue()
      const { config, notes } = await httpAPI.generateConfig({
        goal: goal.trim(),
        docsUrl: docsUrl.trim() || undefined,
        keyedColumn: keyedColumn.trim() || undefined,
        sheetId,
      })
      if (notes) toast(notes, { duration: 5000 })
      const wired = keyValue ? wireAuthHeader(config as HTTPAPIConfig, keyValue) : (config as HTTPAPIConfig)
      onAutoFill(wired, (config as any).connectionName)
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not generate the config')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="border border-gray-200 bg-gray-50 p-4 space-y-3">
      {/* No-key warning as a full-width banner (renders nothing when a key
          exists) — same treatment as the AI Column modal, so both surfaces are
          consistent. Inline, its longer text wrapped across the AI-assist row. */}
      <OpenRouterCreditNotice variant="banner" />
      {/* Proactive "no model" warning — same shape as the no-key banner, so
          the user learns BEFORE clicking Auto-fill, not from the click error. */}
      <NoModelNotice sheetDefaultModel={sheetDefaultModel} />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Sparkles className="h-4 w-4 text-gray-600" />
        <span className="text-sm font-medium text-gray-800">AI assist</span>
        <span className="text-xs text-gray-500">fills the fields below for you</span>
        {/* Short neutral disclosure only; the no-key warning is the banner above. */}
        <OpenRouterCreditNotice neutralOnly className="basis-full" />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">What do you want to look up about each row?</label>
        <input
          type="text"
          className="input w-full"
          placeholder="e.g. Look up each company's headcount and HQ city using Apollo"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Docs URL <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <input
            type="url"
            className="input w-full text-sm"
            placeholder="https://docs.example.com/reference"
            value={docsUrl}
            onChange={(e) => setDocsUrl(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Which column? <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <select className="input w-full text-sm" value={keyedColumn} onChange={(e) => setKeyedColumn(e.target.value)}>
            <option value="">Pick a column</option>
            {columns.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <SavedKeysPicker
        selectedKeyName={selectedKeyName} setSelectedKeyName={setSelectedKeyName}
        inlineKey={inlineKey} setInlineKey={setInlineKey}
        saveInline={saveInline} setSaveInline={setSaveInline}
        inlineKeyName={inlineKeyName} setInlineKeyName={setInlineKeyName}
      />

      <div className="flex justify-end pt-1">
        <button
          onClick={handleAutoFill}
          disabled={loading || !goal.trim()}
          className="btn-primary flex items-center gap-2"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          <span>{loading ? 'Filling fields…' : 'Auto-fill below'}</span>
        </button>
      </div>
      {/* Same inline-error treatment as the AI Column modal's previewError. */}
      {error && <div className="p-2 bg-cube-black text-xs text-white">{error}</div>}
    </div>
  )
}
