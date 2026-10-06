import { useEffect, useRef } from 'react'
import { sheetsAPI, webSearchFrom, type WebSearchSettings } from '@/utils/api'
import { clampConcurrency } from './types'

// Setters the init effect drives. Grouped so the modal passes one object instead
// of a long positional list.
interface InitSetters {
  setColumnSuggestions: (s: Array<{ name: string; reference: string }>) => void
  setColumnName: (v: string) => void
  setPrompt: (v: string) => void
  setSystemPrompt: (v: string) => void
  setModel: (v: string) => void
  setUseOpenRouterWebSearch: (v: boolean) => void
  setWebSearch: (v: WebSearchSettings) => void
  setUseWebFetch: (v: boolean) => void
  setConcurrency: (v: number) => void
  // Called BEFORE an edit-mode payload is applied. Closing the drawer keeps
  // its state now, so an explicit "edit column" open must first clear whatever
  // was retained (another column's form, a streaming preview) — otherwise the
  // prefill lands on top of foreign state.
  onEditPrefill?: () => void
  // True when the modal reopened with RETAINED config (a kept draft — columnName
  // or prompt already present). The modal stays mounted on close, so its model/
  // concurrency survive; without this the reopen's sheet-defaults effect would
  // clobber the retained model back to the sheet default (wrong-model run + lost
  // credit reuse, since the config hash no longer matches the preview's).
  hasRetainedConfig?: () => boolean
}

// Initialize the AI modal on open. Split into two concerns so a saved choice is
// never reverted, yet a sheet default that loads async is still applied:
//
//  1) EDIT-MODE PREFILL ('ai_modal_initial' in localStorage) — synchronous,
//     applied exactly ONCE per open via a guard ref. Re-applying it on a later
//     render (e.g. after a slider save bumps a parent default prop) is what
//     reverted the user's change, so it must NOT depend on the default props.
//
//  2) SHEET DEFAULTS (defaultAiModel / defaultAiConcurrency) — applied in their
//     own effect that depends on them, so a default arriving AFTER open (async
//     sheet load) still lands. This is safe to re-run: the default prop only
//     changes when the user SAVES a new value, at which point the new default
//     equals what they just set — so the re-apply is a no-op, never a clobber.
//     An EXPLICIT model/concurrency choice suppresses the matching default —
//     from an edit-mode prefill OR a hydrated draft (the draft hydration
//     resolves async, so a later-arriving default would otherwise clobber it
//     and break credit reuse via a config-hash mismatch at run time).
//
// Returns the explicit-choice API: `editPrefillApplied()` tells the draft
// hydration an edit open happened (ordering-safe — this hook's effect runs
// first, the one-shot localStorage payload is consumed here); the two note*
// functions let hydration claim model/concurrency as explicit.
export interface AIModalInitHandle {
  editPrefillApplied: () => boolean
  noteExplicitModel: () => void
  noteExplicitConcurrency: () => void
}

export function useAIModalInit(
  isOpen: boolean,
  sheetId: string,
  defaultAiModel: string | null | undefined,
  defaultAiConcurrency: number | null | undefined,
  // Account-wide fallback (Settings → Default AI model). Applied only when the
  // sheet has no default of its own; same explicit-choice suppression rules.
  accountDefaultModel: string | null | undefined,
  s: InitSetters,
): AIModalInitHandle {
  const prefilled = useRef(false)
  const editPrefill = useRef(false)
  const explicitModel = useRef(false)
  const explicitConcurrency = useRef(false)

  // (1) Edit-mode prefill + column suggestions — once per open.
  useEffect(() => {
    if (!isOpen) {
      prefilled.current = false; editPrefill.current = false
      explicitModel.current = false; explicitConcurrency.current = false
      return
    }
    if (prefilled.current) return
    prefilled.current = true

    sheetsAPI.getColumns(sheetId)
      .then(s.setColumnSuggestions)
      .catch(err => console.error('Failed to load column suggestions:', err))

    try {
      const raw = localStorage.getItem('ai_modal_initial')
      if (raw) {
        const init = JSON.parse(raw)
        // One-shot payload: consume it here. resetState no longer runs on
        // close, so nothing else clears it — an unconsumed payload would
        // re-prefill every subsequent open.
        try { localStorage.removeItem('ai_modal_initial') } catch { /* non-fatal */ }
        editPrefill.current = true
        s.onEditPrefill?.()
        if (init.columnName) s.setColumnName(init.columnName)
        if (init.prompt) s.setPrompt(init.prompt)
        if (init.systemPrompt) s.setSystemPrompt(init.systemPrompt)
        if (init.model) { explicitModel.current = true; s.setModel(init.model) }
        if (typeof init.useOpenRouterWebSearch === 'boolean') s.setUseOpenRouterWebSearch(init.useOpenRouterWebSearch)
        s.setWebSearch(webSearchFrom(init.searchEngine, init.searchMode, init.maxSearchesPerRow))
        if (typeof init.useWebFetch === 'boolean') s.setUseWebFetch(init.useWebFetch)
        if (typeof init.concurrency === 'number') { explicitConcurrency.current = true; s.setConcurrency(clampConcurrency(init.concurrency)) }
      }
    } catch { /* corrupt prefill — fall back to sheet defaults below */ }

    // Reopening with retained config (kept draft): the modal stayed mounted, so
    // its model/concurrency are still whatever the user/draft set. Re-mark them
    // explicit so the sheet-defaults effect below can't overwrite the retained
    // model on reopen (option 3 — preserves the async-default-
    // on-first-open behavior, which only runs on a genuinely empty open where
    // hasRetainedConfig is false). NOT for an edit-prefill open (it just set its
    // own values above and marked explicit already).
    if (!editPrefill.current && s.hasRetainedConfig?.()) {
      explicitModel.current = true
      explicitConcurrency.current = true
    }
  }, [isOpen, sheetId]) // eslint-disable-line react-hooks/exhaustive-deps

  // (2) Sheet defaults — re-runnable so an async-arriving default still applies.
  // Model precedence: sheet default > account default. When neither exists the
  // model stays '' and Preview/Run remain disabled until the user picks one —
  // there is deliberately no hardcoded fallback model.
  useEffect(() => {
    if (!isOpen) return
    const fallbackModel = defaultAiModel || accountDefaultModel
    if (!explicitModel.current && fallbackModel) s.setModel(fallbackModel)
    if (!explicitConcurrency.current && typeof defaultAiConcurrency === 'number') {
      s.setConcurrency(clampConcurrency(defaultAiConcurrency))
    }
  }, [isOpen, defaultAiModel, accountDefaultModel, defaultAiConcurrency]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    editPrefillApplied: () => editPrefill.current,
    noteExplicitModel: () => { explicitModel.current = true },
    noteExplicitConcurrency: () => { explicitConcurrency.current = true },
  }
}
