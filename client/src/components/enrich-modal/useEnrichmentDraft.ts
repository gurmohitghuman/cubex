import { useCallback, useState } from 'react'
import { emptyDraft, type EnrichDraft } from './draft'

// One draft per sheet while the page is open: closing the drawer or switching
// sheets keeps it, so reopening resumes Set up. A reload starts fresh (this
// map lives in memory only).
const drafts = new Map<string, EnrichDraft>()

type Patch = Partial<EnrichDraft> | ((draft: EnrichDraft) => Partial<EnrichDraft>)

// The run a sheet's drawer shows on its Test or Run step (null: none). The
// sheet uses it to skip a pause toast the open drawer already explains.
export function draftRunOnScreen(sheetId: string): string | null {
  const d = drafts.get(sheetId)
  return d?.runId && (d.step === 'test' || d.step === 'run') ? d.runId : null
}

export function useEnrichmentDraft(sheetId: string) {
  const [state, setState] = useState(() => ({ sheetId, draft: drafts.get(sheetId) ?? emptyDraft() }))
  // A sheet switch reads that sheet's draft straight away (no stale render of
  // the previous sheet's choices).
  const draft = state.sheetId === sheetId ? state.draft : (drafts.get(sheetId) ?? emptyDraft())

  const update = useCallback((patch: Patch) => {
    setState(prev => {
      const base = prev.sheetId === sheetId ? prev.draft : (drafts.get(sheetId) ?? emptyDraft())
      const next = { ...base, ...(typeof patch === 'function' ? patch(base) : patch) }
      drafts.set(sheetId, next)
      return { sheetId, draft: next }
    })
  }, [sheetId])

  const reset = useCallback(() => {
    drafts.delete(sheetId)
    setState({ sheetId, draft: emptyDraft() })
  }, [sheetId])

  return { draft, update, reset }
}
