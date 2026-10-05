import React from 'react'
import { Eye, Loader2 } from 'lucide-react'
import { AccordionSection } from '../AccordionSection'
import { OpenRouterCreditNotice } from '../OpenRouterCreditNotice'
import { GenerateTab } from './GenerateTab'
import { ConfigureTab } from './ConfigureTab'
import { ModelsHandle } from './useModels'
import { PromptSuggestionsHandle } from './usePromptSuggestions'
import { plural } from '@/lib/utils'

interface Props {
  sheetId: string
  // Generate section
  columnName: string; setColumnName: (v: string) => void
  nameError: string
  prompt: string; setPrompt: (v: string) => void
  useOpenRouterWebSearch: boolean; setUseOpenRouterWebSearch: (b: boolean) => void
  useWebFetch: boolean; setUseWebFetch: (b: boolean) => void
  columnSuggestions: Array<{ name: string; reference: string }>
  sugg: PromptSuggestionsHandle
  // Configure section
  model: string; setModel: (m: string) => void
  systemPrompt: string; setSystemPrompt: (s: string) => void
  concurrency: number; setConcurrency: (n: number) => void
  models: ModelsHandle
  // Defaults context: the sheet's saved default + the account-wide fallback.
  sheetDefaultModel?: string | null
  accountDefaultModel?: string | null
  // The user actively picked a model from the dropdown this session (marks it
  // explicit — hydrated/inherited models never count as picked).
  onModelPicked?: () => void
  // The pick was persisted as this sheet's default (parent cache sync).
  onSheetDefaultSaved?: (m: string) => void
  // The sheet override was cleared ("Use account default").
  onSheetDefaultCleared?: () => void
  onDefaultConcurrencyChanged?: (n: number) => void
  // Footer
  previewSize: number
  isGeneratingPreview: boolean
  previewError: string | null
  onCancel: () => void
  onPreview: () => Promise<unknown>
}

export const ConfigureStep: React.FC<Props> = (p) => {
  // Names the FIRST unmet requirement for a preview, in the SAME order as the
  // CTA's disabled guard below (name error → column name → prompt → model).
  // Deliberately does NOT mention the OpenRouter key: the key never disables
  // the button (the no-key banner above + server-side enforcement own that).
  const disabledReason = p.nameError
    ? p.nameError
    : !p.columnName.trim()
      ? 'Add a column name to continue.'
      : !p.prompt.trim()
        ? 'Add a prompt to continue.'
        : !p.model
          ? 'Choose a model under Configure — or set a default model in Settings.'
          : null

  return (
  <div className="p-4 space-y-3">
    {/* No-key warning lives here as a full-width banner (renders nothing when a
        key exists) — lifted out of the "What would you like AI to do?" label
        row, where its longer text wrapped and collided with the label. */}
    <OpenRouterCreditNotice variant="banner" />
    <AccordionSection title="Generate" defaultOpen>
      <GenerateTab columnName={p.columnName} setColumnName={p.setColumnName} nameError={p.nameError}
        prompt={p.prompt} setPrompt={p.setPrompt}
        useOpenRouterWebSearch={p.useOpenRouterWebSearch} setUseOpenRouterWebSearch={p.setUseOpenRouterWebSearch}
        useWebFetch={p.useWebFetch} setUseWebFetch={p.setUseWebFetch}
        columnSuggestions={p.columnSuggestions}
        showSuggestions={p.sugg.show} setShowSuggestions={p.sugg.setShow}
        suggestFilter={p.sugg.filter} setSuggestFilter={p.sugg.setFilter}
        activeSuggestIndex={p.sugg.activeIndex} setActiveSuggestIndex={p.sugg.setActiveIndex}
        insertColumnReference={p.sugg.insert} />
    </AccordionSection>

    {/* Open the Configure section by default while no model is resolved — the
        blocked CTA points here, so the fix should already be on screen. */}
    <AccordionSection title="Configure" summary={p.model || 'No model selected'} defaultOpen={!p.model}>
      <ConfigureTab sheetId={p.sheetId} model={p.model} setModel={p.setModel}
        systemPrompt={p.systemPrompt} setSystemPrompt={p.setSystemPrompt}
        concurrency={p.concurrency} setConcurrency={p.setConcurrency}
        models={p.models}
        sheetDefaultModel={p.sheetDefaultModel} accountDefaultModel={p.accountDefaultModel}
        onModelPicked={p.onModelPicked} onSheetDefaultSaved={p.onSheetDefaultSaved}
        onSheetDefaultCleared={p.onSheetDefaultCleared}
        onDefaultConcurrencyChanged={p.onDefaultConcurrencyChanged} />
    </AccordionSection>

    <div className="flex justify-between pt-4 border-t border-gray-200">
      <div></div>
      <div className="flex flex-col items-end space-y-1">
        <div className="flex space-x-3">
          <button onClick={p.onCancel} className="btn-secondary">Cancel</button>
          <button onClick={p.onPreview}
            disabled={p.isGeneratingPreview || !p.columnName.trim() || !p.prompt.trim() || !!p.nameError || !p.model}
            className="btn-primary flex items-center space-x-2">
            {p.isGeneratingPreview ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
            <span>{p.isGeneratingPreview ? `Processing ${plural(p.previewSize, 'row')}…` : `Try on ${plural(p.previewSize, 'row')}`}</span>
          </button>
        </div>
        {/* Why the CTA is disabled — same inputs/order as its guard above. */}
        {disabledReason && !p.isGeneratingPreview && (
          <p className="text-xs text-gray-500">{disabledReason}</p>
        )}
      </div>
    </div>
    {p.previewError && <div className="mt-2 p-2 bg-cube-black text-xs text-white">{p.previewError}</div>}
    {p.isGeneratingPreview && (
      <div className="mt-2 p-2 bg-white border border-cube-black text-xs text-cube-black">
        <div className="flex items-center space-x-2">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Processing {plural(p.previewSize, 'row')}…</span>
        </div>
      </div>
    )}
  </div>
  )
}
