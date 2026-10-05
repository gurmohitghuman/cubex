import React, { useMemo, useState } from 'react'
import { AlertTriangle, Bot, Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { OpenRouterModel, Settings, settingsAPI } from '@/utils/api'
import { formatContext, formatPricePerMillion } from '@/components/ai-modal/format'

interface Props {
  settings: Settings | null
  reloadSettings: () => Promise<void>
}

// Account-wide default AI model. AI columns resolve: explicit pick in the AI
// dialog > sheet default > THIS. With none set, AI runs are blocked until a
// model is chosen — there is deliberately no hardcoded fallback.
export const DefaultModelCard: React.FC<Props> = ({ settings, reloadSettings }) => {
  const [models, setModels] = useState<OpenRouterModel[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)

  const current = settings?.defaultAiModel ?? null
  const currentModel = useMemo(() => models.find(m => m.id === current), [models, current])
  // The saved model vanished from OpenRouter's live list. NEVER auto-clear on
  // this (or on a failed list fetch) — just surface it; runs on a dead model
  // fail with the OpenRouter error, they never silently switch models.
  const currentUnlisted = !!current && models.length > 0 && !currentModel

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return models
    return models.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
  }, [models, search])

  const loadModels = async () => {
    if (models.length > 0) return
    setLoading(true); setLoadError(null)
    try { setModels(await settingsAPI.listOpenRouterModels()) }
    catch { setLoadError('Failed to load models. Check your network and try again.') }
    finally { setLoading(false) }
  }

  const save = async (model: string | null) => {
    setSaving(true)
    try {
      await settingsAPI.updateDefaultModel(model)
      await reloadSettings()
      setOpen(false); setSearch('')
    } catch (e: any) {
      toast.error(e.response?.data?.error || 'Failed to save default model')
    } finally { setSaving(false) }
  }

  return (
    <div className="card mb-6">
      <div className="p-6 border-b border-gray-200">
        <div className="flex items-center space-x-3">
          <div className="bg-cube-black p-2 rounded-sm"><Bot className="h-5 w-5 text-white" /></div>
          <div>
            <h3 className="text-title text-gray-900">Default AI Model</h3>
            <p className="text-sm text-gray-600">
              Used by AI columns on every sheet, unless a sheet has its own saved model.
            </p>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-4">
        {settings?.hasOpenRouterKey && !current && (
          <div className="bg-white border border-cube-black rounded-sm p-4 flex items-start space-x-2">
            <AlertTriangle className="h-5 w-5 text-cube-black flex-shrink-0 mt-0.5" />
            <p className="text-sm text-cube-black">
              Pick a default model so AI columns can run without choosing one each time.
              Until a model is selected (here or in the AI column dialog), AI runs are blocked.
            </p>
          </div>
        )}

        <div className="relative">
          <label className="block text-sm font-medium text-gray-700 mb-2">Default model</label>
          <button type="button" disabled={saving}
            onClick={() => { const next = !open; setOpen(next); if (next) loadModels() }}
            className="input w-full text-left flex items-center justify-between">
            <span className="truncate">
              {saving ? <span className="text-gray-500">Saving…</span>
                : currentModel ? (
                  <>
                    <span className="font-medium">{currentModel.name}</span>
                    <span className="text-gray-500 ml-2 text-xs">{currentModel.id}</span>
                  </>
                ) : <span className={current ? '' : 'text-gray-500'}>{current || 'No default model set'}</span>}
            </span>
            <span className="text-gray-400 ml-2">▾</span>
          </button>
          {currentUnlisted && (
            <p className="text-xs text-amber-700 mt-1">
              This model is no longer in OpenRouter's list, so runs using it may fail. Consider picking another.
            </p>
          )}
          {open && (
            <div className="absolute z-20 mt-1 w-full bg-white border border-gray-300 rounded-sm shadow-lg max-h-80 flex flex-col">
              <input autoFocus type="text"
                placeholder="Search models (e.g. claude, gpt-4, gemini)"
                value={search} onChange={(e) => setSearch(e.target.value)}
                className="input w-full border-0 border-b border-gray-200 rounded-none focus:ring-0" />
              {loading ? (
                <div className="p-4 text-sm text-gray-500 flex items-center space-x-2">
                  <Loader2 className="h-4 w-4 animate-spin" /><span>Loading models from OpenRouter…</span>
                </div>
              ) : loadError ? (
                <div className="p-4 text-sm text-red-600">
                  {loadError}
                  <button type="button" onClick={loadModels} className="ml-2 underline">Retry</button>
                </div>
              ) : filtered.length === 0 ? (
                <div className="p-4 text-sm text-gray-500">No models match your search.</div>
              ) : (
                <ul className="overflow-y-auto flex-1">
                  {current && (
                    <li key="__clear">
                      <button type="button" onClick={() => save(null)}
                        className="w-full text-left px-3 py-2 hover:bg-gray-100 border-b border-gray-200">
                        <div className="text-sm font-medium text-gray-900">No default</div>
                        <div className="text-xs text-gray-500">AI columns will require picking a model each time</div>
                      </button>
                    </li>
                  )}
                  {filtered.slice(0, 200).map((m) => (
                    <li key={m.id}>
                      <button type="button" onClick={() => save(m.id)}
                        className={`w-full text-left px-3 py-2 hover:bg-gray-100 ${m.id === current ? 'bg-gray-50' : ''}`}>
                        <div className="text-sm font-medium text-gray-900 truncate">{m.name}</div>
                        <div className="text-xs text-gray-500 truncate">{m.id}</div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          {formatContext(m.context_length)}
                          {m.pricing.prompt && (
                            <> · in {formatPricePerMillion(m.pricing.prompt)} · out {formatPricePerMillion(m.pricing.completion)}</>
                          )}
                        </div>
                      </button>
                    </li>
                  ))}
                  {filtered.length > 200 && (
                    <li className="px-3 py-2 text-xs text-gray-400 text-center">
                      Showing first 200 of {filtered.length} matches. Refine your search to narrow down.
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
