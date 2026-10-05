import React, { useEffect, useRef, useState } from 'react'
import { Globe } from 'lucide-react'
import HTTPTemplateModal from './HTTPTemplateModal'
import { Drawer, DrawerHeader } from './Drawer'
import { httpAPI } from '@/utils/api'
import { HTTPAPIConfig, Step } from './http-modal/types'
import { ConfigureStep } from './http-modal/ConfigureStep'
import { ReviewStep } from './http-modal/ReviewStep'
import { RunStep } from './http-modal/RunStep'
import { SuggestionsDropdown } from './http-modal/SuggestionsDropdown'
import { HTTPHeaderControls, subtitleFor } from './http-modal/ModalHeader'
import { useHTTPRunHandlers } from './http-modal/useHTTPRunHandlers'
import { useSuggestions } from './http-modal/useSuggestions'
import { AIAssistBar } from './http-modal/AIAssistBar'
import { useConfigArrayOps } from './http-modal/useConfigArrayOps'
import { insertReferenceInto } from './http-modal/insertReference'
import { blankHTTPConfig, templateToConfig, saveAsTemplate } from './http-modal/template-helpers'

interface HTTPAPIColumnModalProps {
  isOpen: boolean
  onClose: () => void
  sheetId: string
  // row_generation the sheet was loaded at — forwarded to the preview-commit write
  // so a stale-index write is fenced (409) after a sort/replace elsewhere.
  rowGeneration?: number
  onSuccess: () => void
  onRunStarted?: (runId: string) => void
  // The sheet's saved AI model — the AI-assist "no model" banner stays silent
  // when either this or the account default resolves (same chain as the server).
  defaultAiModel?: string | null
}

export const HTTPAPIColumnModal: React.FC<HTTPAPIColumnModalProps> = ({
  isOpen, onClose, sheetId, rowGeneration, onSuccess, onRunStarted, defaultAiModel,
}) => {
  const [step, setStep] = useState<Step>('configure')
  const [config, setConfig] = useState<HTTPAPIConfig>(blankHTTPConfig)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [showTemplateModal, setShowTemplateModal] = useState(false)
  const [masterColumnName, setMasterColumnName] = useState('')

  const h = useHTTPRunHandlers({
    sheetId, rowGeneration, config, masterColumnName, setStep, setErrors,
    onSuccess, onClose, resetState: () => resetState(),
    onRunStarted,
  })

  function resetState() {
    setStep('configure')
    setConfig(blankHTTPConfig); setErrors({}); setMasterColumnName('')
    h.setPreviewResults([]); h.setSelectedFields(new Set()); h.setAvailableFields(new Set())
    h.setCurrentRun(null); h.setRunResults([])
  }

  useEffect(() => { if (isOpen) resetState() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [isOpen, sheetId])

  // Latest run id, for the poll's in-flight guard: a resetState (close / sheet
  // switch) clears currentRun, but a getRun already awaiting would resolve and
  // resurrect the stale run into fresh state — re-arming the interval with the
  // drawer closed. Mirrors the AI modal's ownedRunId guard.
  const ownedRunId = useRef<string | null>(null)
  ownedRunId.current = h.currentRun?.id ?? null

  // Poll for run updates while a run is live AND the drawer is open. Stops on a
  // terminal status. Once closed, the sheet page's SSE keeps the grid current,
  // so polling on would only burn rate-limit budget (which rate-limited
  // autosave → dropped edits). 'paused' is NOT terminal — polling continues.
  useEffect(() => {
    if (!h.currentRun?.id || !isOpen) return
    const interval = setInterval(async () => {
      try {
        const { run, results } = await httpAPI.getRun(h.currentRun!.id)
        if (ownedRunId.current !== run.id) return // reset/superseded while in flight
        h.setCurrentRun(run); h.setRunResults(results)
        if (['completed', 'failed', 'cancelled'].includes(run.status)) clearInterval(interval)
      } catch (error) { console.error('Failed to poll HTTP run:', error) }
    }, 1000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h.currentRun?.id, isOpen])

  const updateConfig = (updates: Partial<HTTPAPIConfig>) => setConfig(prev => ({ ...prev, ...updates }))
  const sugg = useSuggestions(isOpen, sheetId, (ref, target) => insertReferenceInto(config, updateConfig, ref, target))
  const arrOps = useConfigArrayOps(config, updateConfig)
  const {
    addQueryParam, removeQueryParam, updateQueryParam,
    addHeader, removeHeader, updateHeader,
    addResponseMapping, removeResponseMapping, updateResponseMapping,
  } = arrOps

  const handleSelectTemplate = (template: any) => {
    setConfig(templateToConfig(template))
    setErrors({}); setShowTemplateModal(false)
  }
  const handleSaveAsTemplate = (name: string, description?: string, tags?: string, isDraft?: boolean) =>
    saveAsTemplate(config, name, description, tags, isDraft)

  const handleClose = () => { onClose(); resetState() }

  // AIAssistBar's Auto-fill writes into the same `config` state ConfigureStep
  // edits below, so the user immediately sees what the AI populated and can
  // tweak any field before clicking Try on 1 row.
  const handleAutoFill = (generated: HTTPAPIConfig, connectionName?: string) => {
    setConfig(generated)
    if (connectionName) setMasterColumnName(connectionName)
  }

  return (
    // Clay-style narrow right-side drawer. The config is a vertical accordion
    // (Method/Endpoint, Query, Body, Headers, Response, Settings — all stacked,
    // single-column), so this stays a true side panel at max-w-lg (~512px), a touch
    // roomier than the Webhook drawer for the denser config. (panelClassName
    // overrides the Drawer's default max-w-md.)
    <Drawer isOpen={isOpen} onClose={handleClose} panelClassName="max-w-lg">
      <DrawerHeader
        icon={<div className="bg-cube-black p-1.5"><Globe className="h-4 w-4 text-white" /></div>}
        title="HTTP API Column"
        description={subtitleFor(step)}
        headerRight={
          <HTTPHeaderControls step={step} currentRun={h.currentRun}
            onShowTemplateModal={() => setShowTemplateModal(true)}
            onPause={h.handlePauseRun} onResume={h.handleResumeRun} onCancel={h.handleCancelRun} />
        }
        onClose={handleClose}
      />

      <div className="flex-1 overflow-y-auto">
        {step === 'configure' && (
          <div className="p-4 space-y-4">
            <AIAssistBar sheetId={sheetId} sheetDefaultModel={defaultAiModel} onAutoFill={handleAutoFill} />
            <ConfigureStep
              config={config} errors={errors}
              masterColumnName={masterColumnName} setMasterColumnName={setMasterColumnName}
              updateConfig={updateConfig}
              addQueryParam={addQueryParam} removeQueryParam={removeQueryParam} updateQueryParam={updateQueryParam}
              addHeader={addHeader} removeHeader={removeHeader} updateHeader={updateHeader}
              addResponseMapping={addResponseMapping} removeResponseMapping={removeResponseMapping}
              updateResponseMapping={updateResponseMapping}
              handleInputChange={sugg.handleInputChange} handleSuggestionKeyDown={sugg.handleKeyDown}
              isGeneratingPreview={h.isGeneratingPreview}
              previewError={h.previewError}
              onPreview={h.handleGeneratePreview}
              onCancel={handleClose}
              onShowTemplateModal={() => setShowTemplateModal(true)}
            />
          </div>
        )}

        {step === 'preview' && (
          <ReviewStep
            sheetId={sheetId}
            previewResults={h.previewResults}
            config={config}
            updateConfig={updateConfig}
            selectedFields={h.selectedFields} setSelectedFields={h.setSelectedFields}
            isCommittingPreview={h.isCommittingPreview}
            onBack={() => setStep('configure')}
            onCommit={h.handleCommitPreviewToSheet}
            onStartRun={h.handleStartRun}
            onApplyAIFix={async (next) => {
              setConfig(next)
              // Re-run preview against the AI's proposed fix immediately,
              // passing the override so we don't read stale closure state.
              await h.handleGeneratePreview(next)
            }}
          />
        )}

        {step === 'run' && h.currentRun && (
          // "View Results" closes the modal — the results ARE the grid. The
          // old target, setStep('review'), had no render branch and showed a
          // blank modal body.
          <RunStep currentRun={h.currentRun} runResults={h.runResults} onViewResults={handleClose} />
        )}
      </div>

      <SuggestionsDropdown show={sugg.show} suggestions={sugg.suggestions}
        filter={sugg.filter} activeIndex={sugg.activeIndex}
        onSelect={sugg.select} onDismiss={sugg.dismiss} />

      <HTTPTemplateModal
        isOpen={showTemplateModal}
        onClose={() => setShowTemplateModal(false)}
        onSelectTemplate={handleSelectTemplate}
        currentConfig={config}
        onSaveAsTemplate={handleSaveAsTemplate}
      />
    </Drawer>
  )
}
