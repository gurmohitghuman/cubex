import { useState } from 'react'
import toast from 'react-hot-toast'
import { httpAPI, sheetsAPI, HTTPResult, HTTPRun } from '@/utils/api'
import { HTTPAPIConfig, HTTPPreview, Step } from './types'
import { toServerConfig } from './toServerConfig'
import { cellValueToString, derivedMasterName as buildMasterName, extractByJsonPath } from './cell-helpers'
import { validateHTTPConfig, normalizeHttpUrl } from './validateHTTPConfig'

interface Args {
  sheetId: string
  // The row_generation the sheet was last loaded at. Sent with the preview-commit
  // write so the server 409s if a sort / replace-import happened since the preview
  // was generated (the preview's rowIndex values would otherwise land on the wrong
  // rows — migration 021 fence). Undefined ⇒ server skips the check (back-compat).
  rowGeneration?: number
  config: HTTPAPIConfig
  masterColumnName: string
  setStep: (s: Step) => void
  setErrors: (e: Record<string, string>) => void
  onSuccess: () => void
  onClose: () => void
  resetState: () => void
  onRunStarted?: (runId: string) => void
}

export const useHTTPRunHandlers = (a: Args) => {
  const [previewResults, setPreviewResults] = useState<HTTPPreview[]>([])
  const [isGeneratingPreview, setIsGeneratingPreview] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [isCommittingPreview, setIsCommittingPreview] = useState(false)
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set())
  const [availableFields, setAvailableFields] = useState<Set<string>>(new Set())
  const [currentRun, setCurrentRun] = useState<HTTPRun | null>(null)
  const [runResults, setRunResults] = useState<HTTPResult[]>([])

  const derivedMasterName = () => buildMasterName(a.masterColumnName, a.config.endpointUrl)

  // Pure validation lives in validateHTTPConfig (see there for the forPreview rules).
  const validateConfig = (forPreview = false): boolean =>
    validateHTTPConfig(a.config, a.setErrors, forPreview)

  // overrideConfig lets AI Generate preview against a freshly setConfig()'d value
  // without waiting for a re-render. Guarded with a string-endpointUrl check so
  // an accidental `<button onClick={handleGeneratePreview}>` (passing a React
  // SyntheticEvent) falls through to a.config rather than blowing up the request.
  const handleGeneratePreview = async (overrideConfig?: HTTPAPIConfig) => {
    const isValidOverride =
      !!overrideConfig && typeof (overrideConfig as any).endpointUrl === 'string'
    const cfg = isValidOverride ? overrideConfig! : a.config
    // Skip the FULL validateConfig when a real override is passed: the
    // overrideConfig came from AI Generate (already shaped) and the user hasn't
    // seen / set a master column name yet — that's enforced in the manual flow.
    if (!isValidOverride && !validateConfig(true)) { toast.error('Please fix configuration errors'); return }
    // But ALWAYS scheme-check the endpoint, even for an AI override — an AI-
    // generated config could carry a non-http(s) URL (file://, a metadata IP).
    // The server SSRF guard is the real defense; this gives an immediate error
    // and stops the client gate from being fully bypassed on the override path.
    if (isValidOverride && normalizeHttpUrl(cfg.endpointUrl) === null) {
      toast.error('Generated config has an invalid URL: must be http(s)://'); return
    }
    setIsGeneratingPreview(true)
    try {
      setPreviewError(null)
      const result = await httpAPI.preview(a.sheetId, toServerConfig(cfg))
      setPreviewResults(result.previewResults)

      const allFields = new Set<string>()
      result.previewResults.forEach(p => {
        if (p.status === 'success' && p.extractedFields) {
          Object.keys(p.extractedFields).forEach(f => allFields.add(f))
        }
      })
      setAvailableFields(allFields)
      // Merge, don't overwrite: user's tree-clicked selections survive re-previews.
      // Prior selections kept if still in responseMapping; new preview-found fields added.
      setSelectedFields(prev => {
        const merged = new Set<string>(prev)
        for (const f of allFields) merged.add(f)
        const validNames = new Set(cfg.responseMapping.map(m => m.columnName))
        for (const name of merged) if (!validNames.has(name)) merged.delete(name)
        return merged
      })
      a.setStep('preview')
    } catch (error: any) {
      const msg = error?.response?.data?.error || error?.message || 'Failed to generate preview'
      setPreviewError(msg)
      toast.error(msg)
    } finally {
      setIsGeneratingPreview(false)
    }
  }

  const handleCommitPreviewToSheet = async () => {
    if (selectedFields.size === 0) return toast.error('Please select at least one field')
    if (previewResults.length === 0) return toast.error('No preview results to add')
    setIsCommittingPreview(true)
    try {
      const filteredMapping = a.config.responseMapping.filter(m => selectedFields.has(m.columnName))
      // Re-extract from rawResponse via JSONPath. extractedFields was server-
      // computed at preview time; tree-clicked leaves added after that point
      // are in responseMapping but not in extractedFields, so reading by
      // columnName returns undefined → every committed cell becomes empty.
      const updates = previewResults
        .filter(r => r.status === 'success' && r.rawResponse !== undefined)
        .flatMap(r => filteredMapping.map(m => ({
          rowIndex: r.rowIndex, columnName: m.columnName,
          value: cellValueToString(extractByJsonPath(r.rawResponse, m.jsonPath)),
        })))
      // mode stays 'upsert' (the default) — preview-commit CREATES the selected
      // columns, which 'update' mode would silently skip. rowGeneration is the
      // safety rail: it fences a stale-index write if the sheet was reordered
      // since preview.
      const { skipped } = await sheetsAPI.updateData(a.sheetId, updates, a.rowGeneration, 'upsert')
      // `skipped` > 0 ⇒ some preview rows were deleted since the preview was
      // generated (this tab or another). The server no longer resurrects them
      // (upsert won't INSERT a missing row), so report what landed vs. dropped.
      const written = updates.length - skipped
      const cols = `${selectedFields.size} column${selectedFields.size !== 1 ? 's' : ''}`
      if (skipped > 0) {
        toast.success(`Added ${written} values across ${cols}; ${skipped} skipped (rows were deleted).`)
      } else {
        toast.success(`Added ${written} values across ${cols}`)
      }
      a.onSuccess()
      a.onClose()
      a.resetState()
    } catch (error: any) {
      // 409 = the sheet was sorted/replaced since the preview was generated, so the
      // preview's rowIndex values are stale. Reload (onSuccess) to refresh the grid
      // + row_generation; the user re-previews against the new order. Mirrors the
      // grid autosave 409 recovery in useCellOps.
      // A busy 409 is different: the sheet is mid-sort/import, the preview is
      // still good, so keep it and let the user try again.
      if (error?.response?.status === 409 && error?.response?.data?.busy) {
        toast.error(error.response.data.error)
      } else if (error?.response?.status === 409) {
        toast.error('This sheet was reordered elsewhere. Reloaded. Re-run the preview.')
        a.onSuccess()
        a.onClose()
        a.resetState()
      } else {
        toast.error(error.response?.data?.error || 'Failed to add columns from preview')
      }
    } finally {
      setIsCommittingPreview(false)
    }
  }

  const handleStartRun = async () => {
    if (selectedFields.size === 0) return toast.error('Please select at least one field')
    // Validate the picked fields, not the blank starter mapping the form opens with.
    const filteredConfig = { ...a.config, responseMapping: a.config.responseMapping.filter(m => selectedFields.has(m.columnName)) }
    if (!validateHTTPConfig(filteredConfig, a.setErrors)) return toast.error('Please fix configuration errors')

    try {
      const result = await httpAPI.startRun(a.sheetId, toServerConfig(filteredConfig), derivedMasterName())
      // No success toast — header pill + visible '⏳ Processing...' cells
      // signal the run is live.
      a.onRunStarted?.(result.runId)

      const { run } = await httpAPI.getRun(result.runId)
      setCurrentRun(run)
      a.setStep('run')
      a.onSuccess()
    } catch (error: any) {
      // Server messages first: the routes return deliberate, actionable errors
      // (column/row cap reached, master-column collision, active-run limit,
      // 409 concurrent run). error.message is axios's generic "Request failed
      // with status code 400" — useless to the user.
      toast.error(error.response?.data?.error || error.message || 'Failed to start HTTP API run')
    }
  }

  // Pause/resume/cancel toasts removed — header pill state changes
  // visibly with each action.
  const handlePauseRun = async () => {
    if (!currentRun) return
    try { await httpAPI.controlRun(currentRun.id, 'pause') }
    catch (error: any) { toast.error(error.response?.data?.error || error.message || 'Failed to pause HTTP API run') }
  }

  const handleResumeRun = async () => {
    if (!currentRun) return
    try { await httpAPI.controlRun(currentRun.id, 'resume') }
    catch (error: any) { toast.error(error.response?.data?.error || error.message || 'Failed to resume HTTP API run') }
  }

  const handleCancelRun = async () => {
    if (!currentRun) return
    try {
      await httpAPI.controlRun(currentRun.id, 'cancel')
      // Back to the config screen (their config is intact, ready to tweak and
      // retry). 'review' had NO render branch — it showed a blank modal.
      a.setStep('configure')
    } catch (error: any) {
      toast.error(error.response?.data?.error || error.message || 'Failed to cancel HTTP API run')
    }
  }

  return {
    previewResults, setPreviewResults,
    isGeneratingPreview, previewError, isCommittingPreview,
    selectedFields, setSelectedFields, availableFields, setAvailableFields,
    currentRun, setCurrentRun, runResults, setRunResults,
    validateConfig,
    handleGeneratePreview, handleCommitPreviewToSheet, handleStartRun,
    handlePauseRun, handleResumeRun, handleCancelRun,
  }
}
