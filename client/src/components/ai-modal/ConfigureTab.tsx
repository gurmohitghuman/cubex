import React from 'react'
import toast from 'react-hot-toast'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Slider } from '@/components/ui/slider'
import { OpenRouterModel, sheetsAPI } from '@/utils/api'
import { formatContext, formatPricePerMillion } from './format'
import { ModelsHandle } from './useModels'
import { MAX_AI_CONCURRENCY, FREE_MODEL_CONCURRENCY_WARN } from '@/lib/constants'
import { plural } from '@/lib/utils'

// A model is "free" when OpenRouter reports zero prompt AND completion price.
// The server normalizes missing pricing to '0' (openrouter.ts), so a model with
// UNKNOWN pricing would read as free too — to avoid a misleading warning on
// those, we also require the OpenRouter ":free" id convention OR a name that says
// "(free)". A genuinely free model satisfies both; an unknown-pricing paid model
// satisfies neither, so it won't trigger the warning. (Worst case: a free model
// missing the convention shows no warning — strictly safer than over-warning.)
const isFreeModel = (m: OpenRouterModel | undefined): boolean => {
  if (!m) return false
  const zeroPrice = parseFloat(m.pricing?.prompt ?? '1') === 0 && parseFloat(m.pricing?.completion ?? '1') === 0
  const labeledFree = /:free\b/.test(m.id) || /\(free\)/i.test(m.name || '')
  return zeroPrice && labeledFree
}

interface Props {
  sheetId: string
  model: string
  setModel: (m: string) => void
  systemPrompt: string
  setSystemPrompt: (v: string) => void
  concurrency: number
  setConcurrency: (n: number) => void
  models: ModelsHandle
  sheetDefaultModel?: string | null
  accountDefaultModel?: string | null
  onModelPicked?: () => void
  onSheetDefaultSaved?: (m: string) => void
  onSheetDefaultCleared?: () => void
  onDefaultConcurrencyChanged?: (n: number) => void
}

export const ConfigureTab: React.FC<Props> = ({
  sheetId, model, setModel, systemPrompt, setSystemPrompt, concurrency, setConcurrency,
  models, sheetDefaultModel, accountDefaultModel, onModelPicked, onSheetDefaultSaved,
  onSheetDefaultCleared, onDefaultConcurrencyChanged,
}) => (
  <div className="space-y-4">
    <div className="space-y-4">
      <div className="relative">
        <label className="block text-sm font-medium text-gray-700 mb-2">Model</label>
        <button type="button" onClick={() => models.setModelDropdownOpen(!models.modelDropdownOpen)}
          className="input w-full text-left flex items-center justify-between">
          <span className="truncate">
            {models.selectedModel ? (
              <>
                <span className="font-medium">{models.selectedModel.name}</span>
                <span className="text-gray-500 ml-2 text-xs">{models.selectedModel.id}</span>
              </>
            ) : <span className="text-gray-500">{model || 'Select a model…'}</span>}
          </span>
          <span className="text-gray-400 ml-2">▾</span>
        </button>
        {models.modelDropdownOpen && (
          <div className="absolute z-20 mt-1 w-full bg-white border border-gray-300 rounded-sm shadow-lg max-h-80 flex flex-col">
            <input autoFocus type="text"
              placeholder="Search models (e.g. claude, gpt-4, gemini)"
              value={models.modelSearch} onChange={(e) => models.setModelSearch(e.target.value)}
              className="input w-full border-0 border-b border-gray-200 rounded-none focus:ring-0" />
            {models.modelsLoading ? (
              <div className="p-4 text-sm text-gray-500 flex items-center space-x-2">
                <Loader2 className="h-4 w-4 animate-spin" /><span>Loading models from OpenRouter…</span>
              </div>
            ) : models.modelsError ? (
              <div className="p-4 text-sm text-red-600">
                {models.modelsError}
                <button type="button" onClick={models.loadModels} className="ml-2 underline">Retry</button>
              </div>
            ) : models.filteredModels.length === 0 ? (
              <div className="p-4 text-sm text-gray-500">No models match your search.</div>
            ) : (
              <ul className="overflow-y-auto flex-1">
                {/* Escape hatch from a sheet override: once a sheet default is
                    set it shadows the account default forever — this clears it
                    (persisted immediately; it IS the action, unlike a model
                    pick, which only saves when a run starts). */}
                {sheetDefaultModel && accountDefaultModel && (
                  <li key="__account_default">
                    <button type="button"
                      onClick={() => {
                        setModel(accountDefaultModel)
                        models.setModelDropdownOpen(false); models.setModelSearch('')
                        // Optimistic (mirrors column rename): the parent cache
                        // updates now; a rare failure is surfaced via toast so a
                        // silent server/client disagreement can't linger.
                        sheetsAPI.updateDefaultModel(sheetId, null)
                          .catch(() => toast.error("Failed to clear this sheet's saved model — it still overrides the account default."))
                        onSheetDefaultCleared?.()
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-gray-100 border-b border-gray-200">
                      <div className="text-sm font-medium text-gray-900">Use account default</div>
                      <div className="text-xs text-gray-500 truncate">{accountDefaultModel} — clears this sheet's saved model</div>
                    </button>
                  </li>
                )}
                {models.filteredModels.slice(0, 200).map((mm) => (
                  <li key={mm.id}>
                    <button type="button"
                      onClick={() => {
                        // Persist IMMEDIATELY (owner spec: selecting a model in a
                        // sheet saves it for that sheet — it must survive a plain
                        // refresh, not just a started run). The "Use account
                        // default" entry above is the escape from a stray click.
                        setModel(mm.id)
                        models.setModelDropdownOpen(false); models.setModelSearch('')
                        onModelPicked?.()
                        sheetsAPI.updateDefaultModel(sheetId, mm.id)
                          .then(() => onSheetDefaultSaved?.(mm.id))
                          .catch(() => toast.error("Couldn't save this model for the sheet — it may reset on reload."))
                      }}
                      className={`w-full text-left px-3 py-2 hover:bg-gray-100 ${mm.id === model ? 'bg-gray-50' : ''}`}>
                      <div className="text-sm font-medium text-gray-900 truncate">{mm.name}</div>
                      <div className="text-xs text-gray-500 truncate">{mm.id}</div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        {formatContext(mm.context_length)}
                        {mm.pricing.prompt && (
                          <> · in {formatPricePerMillion(mm.pricing.prompt)} · out {formatPricePerMillion(mm.pricing.completion)}</>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
                {models.filteredModels.length > 200 && (
                  <li className="px-3 py-2 text-xs text-gray-400 text-center">
                    Showing first 200 of {models.filteredModels.length} matches. Refine your search to narrow down.
                  </li>
                )}
              </ul>
            )}
          </div>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Concurrency: {plural(concurrency, 'request')}
        </label>
        <Slider value={[concurrency]} onValueChange={(value) => setConcurrency(value[0])}
          onValueCommit={(value) => {
            // Persist on RELEASE (not every drag tick) so this sheet remembers the
            // choice next time.
            sheetsAPI.updateDefaultConcurrency(sheetId, value[0]).catch(err =>
              console.error('Failed to save default concurrency:', err))
            onDefaultConcurrencyChanged?.(value[0])
          }}
          max={MAX_AI_CONCURRENCY} min={1} step={1} className="w-full" />
        <div className="flex justify-between text-xs text-gray-500 mt-1">
          <span>1 (Slow)</span><span>{MAX_AI_CONCURRENCY} (Fast)</span>
        </div>
        {isFreeModel(models.selectedModel) && concurrency > FREE_MODEL_CONCURRENCY_WARN && (
          <div className="mt-2 flex items-start gap-2 rounded-sm border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>
              This is a free model. Concurrency above {FREE_MODEL_CONCURRENCY_WARN} will likely hit
              OpenRouter rate limits and cause failed rows. Lower it, or switch to a paid model.
            </span>
          </div>
        )}
      </div>
    </div>

    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">System Prompt (optional)</label>
      <textarea className="input w-full h-32 resize-none font-mono text-sm"
        placeholder="Additional instructions for the AI…"
        value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
      <p className="text-xs text-gray-500 mt-1">Provide additional context or instructions for the AI model</p>
    </div>
  </div>
)
