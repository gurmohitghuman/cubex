import React, { useState } from 'react'
import { Bot } from 'lucide-react'
import { aiAPI, DEFAULT_WEB_SEARCH, webSearchFrom, type WebSearchSettings } from '@/utils/api'
import { Drawer, DrawerHeader } from './Drawer'

import { Step, DEFAULT_SYSTEM_PROMPT, DEFAULT_CONCURRENCY, clampConcurrency } from './ai-modal/types'
import { useAIModalInit } from './ai-modal/useAIModalInit'
import { useModelSelection } from './ai-modal/useModelSelection'
import { useAIDraftHydration, takesRenamedRefs } from './ai-modal/useAIDraftHydration'
import { useDrawerLifecycle } from './ai-modal/useDrawerLifecycle'
import { AIHeaderControls, subtitleFor } from './ai-modal/ModalHeader'
import { ConfigureStep } from './ai-modal/ConfigureStep'
import { PreviewStep } from './ai-modal/PreviewStep'
import { RunStep } from './ai-modal/RunStep'
import { useModels } from './ai-modal/useModels'
import { useAIRunHandlers } from './ai-modal/useAIRunHandlers'
import { useColumnNameValidation } from './ai-modal/useColumnNameValidation'
import { usePromptSuggestions } from './ai-modal/usePromptSuggestions'

interface AIColumnModalProps {
  isOpen: boolean
  onClose: () => void
  sheetId: string
  // row_generation the sheet was loaded at — forwarded to the preview-commit write
  // so a stale-index write is fenced (409) after a sort/replace elsewhere.
  rowGeneration?: number
  onSuccess: () => void
  onRunStarted?: (runId: string) => void
  defaultAiModel?: string | null
  // null = the sheet override was cleared ("Use account default").
  onDefaultModelChanged?: (model: string | null) => void
  defaultAiConcurrency?: number | null
  onDefaultConcurrencyChanged?: (concurrency: number) => void
}

export const AIColumnModal: React.FC<AIColumnModalProps> = ({
  isOpen, onClose, sheetId, rowGeneration, onSuccess, onRunStarted, defaultAiModel, onDefaultModelChanged,
  defaultAiConcurrency, onDefaultConcurrencyChanged,
}) => {
  const [step, setStep] = useState<Step>('configure')
  const [columnName, setColumnName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT)
  // Model value + provenance (no hardcoded default; picked-this-session flag).
  const sel = useModelSelection(isOpen, onDefaultModelChanged)
  const [useOpenRouterWebSearch, setUseOpenRouterWebSearch] = useState(false)
  // Web search engine, mode and per-row limit (sent only with web search on).
  const [webSearch, setWebSearch] = useState<WebSearchSettings>(DEFAULT_WEB_SEARCH)
  const [useWebFetch, setUseWebFetch] = useState(false)
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY)

  const temperature = 0.2
  const maxChars: number | undefined = undefined
  const previewSize = 5

  const [columnSuggestions, setColumnSuggestions] = useState<Array<{ name: string; reference: string }>>([])
  const [editingName, setEditingName] = useState<string | null>(null) // the column an edit opened on
  const nameError = useColumnNameValidation(columnName, columnSuggestions, editingName)
  const sugg = usePromptSuggestions(prompt, setPrompt)

  const models = useModels(isOpen, sel.model)

  const h = useAIRunHandlers({
    isOpen, sheetId, rowGeneration, columnName, prompt, systemPrompt, model: sel.model,
    useOpenRouterWebSearch, webSearch, useWebFetch, concurrency, nameError,
    previewSize, temperature, maxChars,
    setStep, onSuccess, onClose, onRunStarted, resetState: () => resetState(),
  })

  function resetState() {
    // Abort any in-flight preview stream first — otherwise it keeps writing rows
    // into the state we're about to clear and keeps the server calling OpenRouter.
    h.abortPreview()
    setStep('configure'); setColumnName(''); setPrompt(''); setSystemPrompt(DEFAULT_SYSTEM_PROMPT)
    // Back to the defaults chain (sheet default > account default > '').
    sel.setModel(defaultAiModel || sel.accountDefaultModel || '')
    sel.resetPicked()
    setUseOpenRouterWebSearch(false); setWebSearch(DEFAULT_WEB_SEARCH); setUseWebFetch(false); setConcurrency(DEFAULT_CONCURRENCY)
    h.setPreviewResults([]); h.setCurrentRun(null); h.setIsPolling(false)
    try { localStorage.removeItem('ai_modal_initial') } catch {}
  }

  // Prefill on open from edit-mode payload or sheet defaults (once per open).
  const init = useAIModalInit(isOpen, sheetId, defaultAiModel, defaultAiConcurrency, sel.accountDefaultModel, {
    setColumnSuggestions, setColumnName, setPrompt, setSystemPrompt, setModel: sel.setModel, setEditingName,
    setUseOpenRouterWebSearch, setWebSearch, setUseWebFetch, setConcurrency,
    onEditPrefill: () => resetState(),
    // Retained config = the modal reopened with a kept draft still in state.
    // Reading current columnName/prompt is safe: the init effect runs on the
    // open render, so it sees the state React retained across the close.
    hasRetainedConfig: () => !!columnName || !!prompt,
  })
  // Late-bind so a dropdown pick marks the model explicit in the init hook (an
  // async-arriving default must not overwrite a fresh pick — see useModelSelection).
  sel.noteExplicitModel.current = init.noteExplicitModel

  // Hydrate from the persisted draft (written server-side by "Try on 5 rows") —
  // closing the drawer no longer loses the prompt or the paid-for preview. A
  // complete fresh preview reopens ON the preview step, mid-flow.
  useAIDraftHydration(isOpen, sheetId, {
    hadEditPrefill: init.editPrefillApplied,
    // pickedThisSession guard: the draft fetch resolves async — a user who
    // already picked a model must not have a stale draft clobber it.
    canApply: () => !h.currentRun && !columnName && !prompt && !sel.pickedThisSession(),
    applyConfig: (c) => {
      setColumnName(c.columnName); setPrompt(c.prompt)
      setSystemPrompt(c.systemPrompt || DEFAULT_SYSTEM_PROMPT)
      // Claim model/concurrency as explicit BEFORE setting them — a sheet
      // default arriving after this hydration must not clobber the draft's
      // values (it would break credit reuse via a config-hash mismatch).
      init.noteExplicitModel(); sel.setModel(c.model)
      init.noteExplicitConcurrency(); setConcurrency(clampConcurrency(c.concurrency))
      setUseOpenRouterWebSearch(c.useOpenRouterWebSearch); setUseWebFetch(c.useWebFetch)
      setWebSearch(webSearchFrom(c.searchEngine, c.searchMode, c.maxSearchesPerRow))
    },
    applyPreview: (rows, target, c) => { h.hydratePreview(rows, target, c); setStep('preview') },
    // Kept state + a column renamed since: take the draft's renamed /references.
    syncRefs: (c, cols) => { if (!h.currentRun && c.columnName === columnName) setPrompt(p => (takesRenamedRefs(p, c.prompt, cols) ? c.prompt : p)) },
  })

  // Close keeps state (a streaming preview continues, reopening resumes where
  // you left off); Back + close resets; sheet switch resets; a dead run step
  // self-heals. All in useDrawerLifecycle.
  const drawer = useDrawerLifecycle({
    isOpen, sheetId, step,
    currentRun: h.currentRun, isPolling: h.isPolling, setIsPolling: h.setIsPolling,
    onClose, resetState: () => resetState(),
  })
  const handleClose = drawer.handleClose

  return (
    // Clay-style narrow right-side drawer (mirrors the HTTP API drawer). The config is
    // a 2-section accordion (Generate / Configure), so this stays a true side panel at
    // max-w-lg (~512px). (panelClassName overrides the Drawer's default max-w-md.)
    <Drawer isOpen={isOpen} onClose={handleClose} panelClassName="max-w-lg">
      <DrawerHeader
        icon={<div className="bg-cube-black p-1.5"><Bot className="h-4 w-4 text-white" /></div>}
        title="AI Column"
        description={subtitleFor(step)}
        headerRight={
          <AIHeaderControls step={step} currentRun={h.currentRun}
            onPause={h.handlePauseRun} onResume={h.handleResumeRun} onCancel={h.handleCancelRun} />
        }
        onClose={handleClose}
      />

      <div className="flex-1 overflow-y-auto">
        {step === 'configure' && (
          <ConfigureStep
            sheetId={sheetId}
            columnName={columnName} setColumnName={setColumnName} nameError={nameError}
            prompt={prompt} setPrompt={setPrompt}
            useOpenRouterWebSearch={useOpenRouterWebSearch} setUseOpenRouterWebSearch={setUseOpenRouterWebSearch}
            webSearch={webSearch} setWebSearch={setWebSearch}
            useWebFetch={useWebFetch} setUseWebFetch={setUseWebFetch}
            columnSuggestions={columnSuggestions}
            sugg={sugg} models={models}
            model={sel.model} setModel={sel.setModel}
            systemPrompt={systemPrompt} setSystemPrompt={setSystemPrompt}
            concurrency={concurrency} setConcurrency={setConcurrency}
            sheetDefaultModel={defaultAiModel} accountDefaultModel={sel.accountDefaultModel}
            onModelPicked={sel.onModelPicked} onSheetDefaultSaved={onDefaultModelChanged}
            onSheetDefaultCleared={sel.onSheetDefaultCleared}
            onDefaultConcurrencyChanged={onDefaultConcurrencyChanged}
            previewSize={previewSize}
            isGeneratingPreview={h.isGeneratingPreview} previewError={h.previewError}
            onCancel={handleClose}
            onPreview={() => { drawer.keepDraftOnClose(); return h.handleGeneratePreview() }}
          />
        )}

        {step === 'preview' && (
          <PreviewStep previewResults={h.previewResults} setPreviewResults={h.setPreviewResults}
            isCommittingPreview={h.isCommittingPreview}
            isGeneratingPreview={h.isGeneratingPreview} expectedRows={h.expectedRows}
            runTargetRows={h.runTargetRows} modelPricing={models.selectedModel?.pricing}
            usesWebTools={useOpenRouterWebSearch || useWebFetch} webSearchPlan={h.previewWebSearch}
            nameError={nameError}
            // Back is the explicit "discard this attempt": it deletes the
            // persisted draft (owner decision), so the NEXT open starts fresh —
            // draftDiscarded makes the next close reset the retained state too.
            // The on-screen form keeps its values for this session.
            onBack={() => {
              aiAPI.deleteDraft(sheetId).catch(() => {})
              drawer.discardDraftOnClose()
              setStep('configure')
            }}
            onCommit={h.handleCommitPreviewToSheet}
            onStartRun={h.handleStartRun} />
        )}

        {step === 'run' && h.currentRun && (
          <RunStep currentRun={h.currentRun} runResults={h.runResults} spend={h.runSpend} />
        )}
      </div>

    </Drawer>
  )
}
