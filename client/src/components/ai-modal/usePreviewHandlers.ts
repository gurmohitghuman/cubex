import { useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { aiAPI, sheetsAPI, webSearchBody, type AIDraft, type SearchPlanSummary, type WebSearchSettings } from '@/utils/api'
import { AIPreview, Step } from './types'

// The slice of the AI modal's config the preview path needs. Kept narrow so this
// hook isn't coupled to run-lifecycle args (concurrency, onRunStarted, …).
interface PreviewArgs {
  sheetId: string
  // The row_generation the sheet was last loaded at. Sent with the preview-commit
  // write so the server 409s if a sort / replace-import happened since the preview
  // was generated (the preview's rowIndex values would otherwise land on the wrong
  // rows — migration 021 fence). Undefined ⇒ server skips the check (back-compat).
  rowGeneration?: number
  columnName: string
  prompt: string
  systemPrompt: string
  model: string
  useOpenRouterWebSearch: boolean
  webSearch: WebSearchSettings
  useWebFetch: boolean
  // Rides the preview request only so the server-side draft can restore the
  // user's slider on reopen — the preview itself doesn't use it.
  concurrency: number
  nameError: string
  previewSize: number
  temperature: number
  maxChars: number | undefined
  setStep: (s: Step) => void
  onSuccess: () => void
  onClose: () => void
  resetState: () => void
}

// Preview-generation + preview-commit handlers, split out of useAIRunHandlers so
// each file stays under the 200-line guardrail and the two concerns (preview vs
// run lifecycle) live apart.
export const usePreviewHandlers = (a: PreviewArgs) => {
  const [previewResults, setPreviewResults] = useState<AIPreview[]>([])
  const [isGeneratingPreview, setIsGeneratingPreview] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [isCommittingPreview, setIsCommittingPreview] = useState(false)
  // How many rows the stream will actually deliver. Starts at the requested size so
  // placeholders render immediately, then is corrected to the server's {type:'done'}
  // totalRows — a short sheet returns fewer than previewSize, and we must not leave
  // ghost "Generating…" placeholders or block commit waiting for rows that never come.
  const [expectedRows, setExpectedRows] = useState(0)
  // Unfiltered count of rows "Run All Rows" will process — from the server's
  // {type:'done'}. Used for the cost estimate so it matches what the run actually
  // bills, NOT the client's filter-aware sheetData.totalRows (which understates when
  // the empty-filter is active).
  const [runTargetRows, setRunTargetRows] = useState(0)
  // With web search: the engine the preview's (and the run's) searches go to,
  // priced, from the server's final stream line.
  const [previewWebSearch, setPreviewWebSearch] = useState<SearchPlanSummary | null>(null)
  // Aborts the in-flight preview fetch. Replaced each run; aborted on close/reset and
  // before starting a new preview so a stale stream can't write into fresh state or
  // keep the server calling OpenRouter.
  const abortRef = useRef<AbortController | null>(null)

  const previewBody = () => ({
    sheetId: a.sheetId, columnName: a.columnName.trim(), prompt: a.prompt,
    systemPrompt: a.systemPrompt || undefined, model: a.model,
    temperature: a.temperature,
    useOpenRouterWebSearch: a.useOpenRouterWebSearch, useWebFetch: a.useWebFetch,
    ...webSearchBody(a.useOpenRouterWebSearch, a.webSearch),
    maxChars: a.maxChars, previewSize: a.previewSize, concurrency: a.concurrency,
  })

  // Restore a persisted preview (draft hydration on modal open) — same state
  // the streaming path builds, minus the stream. The search plan isn't saved
  // with it, so ask for it again.
  const hydratePreview = (results: AIPreview[], targetRows: number, c?: AIDraft['config']) => {
    setPreviewResults(results)
    setExpectedRows(results.length)
    setRunTargetRows(targetRows)
    setPreviewWebSearch(null)
    if (c?.useOpenRouterWebSearch) {
      aiAPI.searchPlan({ model: c.model, engine: c.searchEngine || 'auto', mode: c.searchMode || '', cap: c.maxSearchesPerRow ?? null })
        .then(r => setPreviewWebSearch(r.plan)).catch(() => {})
    }
  }

  // Cancel any in-flight preview (modal close, reset, or a fresh preview superseding
  // it). Closes the socket → the server stops streaming and stops calling OpenRouter.
  const abortPreview = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setIsGeneratingPreview(false)
  }

  const handleGeneratePreview = async () => {
    if (!a.columnName.trim() || !a.prompt.trim() || a.nameError) {
      return toast.error('Column name and prompt are required')
    }
    // Mirrors the server's no-model 400 — a preview must never run on a model
    // the user didn't choose (directly or via a default).
    if (!a.model) {
      return toast.error('Choose a model under Configure — or set a default model in Settings.')
    }
    // Supersede any previous in-flight stream before starting a new one.
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setIsGeneratingPreview(true)
    setPreviewError(null)
    // Move to the preview step immediately and clear stale rows so the user sees
    // rows stream in (sorted by rowIndex as they arrive) instead of staring at the
    // configure spinner until the whole batch finishes.
    setPreviewResults([])
    setPreviewWebSearch(null)
    setExpectedRows(a.previewSize)
    a.setStep('preview')
    try {
      const { totalRows, runTargetRows: target, webSearch } = await aiAPI.previewStream(previewBody(), (row) => {
        // Ignore late rows from a superseded/aborted stream.
        if (controller.signal.aborted) return
        // Sort by the server's display ordinal (its sample order), NOT rowIndex: rows
        // stream back in completion order and the server owns the order. Fall back
        // to rowIndex if previewIndex is absent (older server).
        const key = (r: typeof row) => r.previewIndex ?? r.rowIndex
        setPreviewResults(prev =>
          [...prev, row].sort((x, y) => key(x) - key(y)))
      }, controller.signal)
      // Server is authoritative on the count (short sheets return < previewSize).
      if (!controller.signal.aborted) { setExpectedRows(totalRows); setRunTargetRows(target); setPreviewWebSearch(webSearch) }
    } catch (error: any) {
      // A deliberate abort (close/supersede) is not an error — drop silently.
      if (controller.signal.aborted || error?.name === 'AbortError') return
      // fetch path throws Error(message); keep the axios-shape fallback for safety.
      const msg = error?.message || error?.response?.data?.error || 'Failed to generate preview'
      // Clear partial results so the user can't commit a truncated set.
      setPreviewResults([]); setExpectedRows(0); setRunTargetRows(0)
      setPreviewError(msg); toast.error(msg)
      a.setStep('configure')
    } finally {
      // Only the CURRENT controller clears the flag — a superseded run's finally
      // must not flip the new run's spinner off.
      if (abortRef.current === controller) {
        setIsGeneratingPreview(false)
        abortRef.current = null
      }
    }
  }

  const handleCommitPreviewToSheet = async () => {
    if (!a.columnName.trim()) return toast.error('Column name is required')
    if (a.nameError) return toast.error(a.nameError)
    // Don't commit a partial set while rows are still streaming (the button is also
    // disabled in the UI — this is the programmatic backstop).
    if (isGeneratingPreview) return toast.error('Preview is still generating')
    if (previewResults.length === 0) return toast.error('No preview results to add')

    setIsCommittingPreview(true)
    try {
      const updates = previewResults.map(p => ({
        rowIndex: p.rowIndex, columnName: a.columnName.trim(),
        value: p.error ? '' : p.value,
      }))
      // mode stays 'upsert' (the default) — preview-commit CREATES the new column,
      // which 'update' mode would silently skip. rowGeneration is the safety rail:
      // it fences a stale-index write if the sheet was reordered since preview.
      const { skipped } = await sheetsAPI.updateData(a.sheetId, updates, a.rowGeneration, 'upsert')
      // `skipped` > 0 ⇒ some preview rows were deleted since the preview was
      // generated (this tab or another). The server no longer resurrects them
      // (upsert won't INSERT a missing row), so report what landed vs. dropped.
      const written = updates.length - skipped
      if (skipped > 0) {
        toast.success(`Added ${written} values to "${a.columnName.trim()}"; ${skipped} skipped (rows were deleted).`)
      } else {
        toast.success(`Added ${written} values to column "${a.columnName.trim()}"`)
      }
      a.onSuccess(); a.onClose(); a.resetState()
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
        a.onSuccess(); a.onClose(); a.resetState()
      } else {
        toast.error(error.response?.data?.error || 'Failed to add column from preview')
      }
    } finally {
      setIsCommittingPreview(false)
    }
  }

  return {
    previewResults, setPreviewResults, isGeneratingPreview, previewError, isCommittingPreview,
    expectedRows, runTargetRows, previewWebSearch, abortPreview, hydratePreview,
    handleGeneratePreview, handleCommitPreviewToSheet,
  }
}
