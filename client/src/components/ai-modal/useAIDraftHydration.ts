import { useEffect, useRef } from 'react'
import { aiAPI, sheetsAPI } from '@/utils/api'
import type { AIDraft } from '@/utils/api'
import { AIPreview } from './types'

interface HydrationCallbacks {
  // Edit-mode open (grid menu → edit column) is explicit user intent for a
  // SPECIFIC column — it wins over the draft. Comes from useAIModalInit (whose
  // effect runs first and consumes the one-shot localStorage payload, so
  // checking localStorage here would always miss).
  hadEditPrefill: () => boolean
  // Refuse to hydrate: a run is active, or the user already typed something
  // (the fetch is async — a fast typist must never be clobbered).
  canApply: () => boolean
  applyConfig: (config: AIDraft['config']) => void
  // Non-null previewResults ⇒ the preview is complete AND fresh (the server
  // withholds stale ones) — restore it and land on the preview step.
  applyPreview: (rows: AIPreview[], runTargetRows: number) => void
  // Called instead when canApply refuses (the panel kept its state from an
  // earlier open): a column renamed since then is already renamed in the
  // server draft, so the caller can take its prompt (see takesRenamedRefs).
  syncRefs?: (config: AIDraft['config'], columns: Array<{ name: string; reference: string }>) => void
}

// After a column rename the server rewrote the draft's /references, but a panel
// that kept its state still shows the old ones. Take the draft's prompt only when
// that's the whole story: the prompts differ only in references, the panel's
// prompt names a column that no longer exists, and every reference in the
// draft's exists, so neither unsaved wording nor a user's own reference edit is
// undone. Same token pattern and matching rule as the server (lib/prompt.ts).
const REF = /(?<![/:\w])\/([a-zA-Z0-9_-]+)/g
export function takesRenamedRefs(
  current: string, draft: string, columns: Array<{ name: string; reference: string }>,
): boolean {
  const refs = (p: string) => [...p.matchAll(REF)].map(m => m[1])
  const exists = (t: string) => columns.some(c => c.reference === `/${t}` || c.name.toLowerCase() === t.toLowerCase())
  const prose = (p: string) => p.replace(REF, '/')
  return current !== draft && prose(current) === prose(draft) &&
    refs(current).some(t => !exists(t)) && refs(draft).every(exists)
}

// Hydrate the AI Column modal from the persisted draft on open.
// The draft is written server-side when the
// user runs "Try on 5 rows", so closing the drawer no longer loses the prompt
// or the (paid-for) preview. Best-effort: any failure just opens a blank modal.
export function useAIDraftHydration(
  isOpen: boolean,
  sheetId: string,
  callbacks: HydrationCallbacks,
): void {
  // The effect fires once per (open, sheet), but the fetch resolves later —
  // read the callbacks through a ref so the staleness checks see CURRENT
  // state, not the state captured when the drawer opened.
  const cb = useRef(callbacks)
  cb.current = callbacks
  // Which sheet this open has hydrated (null = none). Keyed by sheet, not a
  // boolean: a sheet switch must re-arm, and a resolve for a sheet that is no
  // longer armed must be DROPPED — otherwise an in-flight fetch for the old
  // sheet lands in the new sheet's freshly-reset (and so canApply-passing)
  // modal state.
  const armedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!isOpen) { armedFor.current = null; return }
    if (armedFor.current === sheetId) return
    armedFor.current = sheetId

    if (cb.current.hadEditPrefill()) return

    aiAPI.getDraft(sheetId)
      .then(draft => {
        if (armedFor.current !== sheetId) return // sheet switched / drawer closed mid-fetch
        if (!draft) return
        if (!cb.current.canApply()) {
          // Judge against the sheet's CURRENT columns: the panel's own list may
          // still be loading, or be the one from its previous open.
          if (cb.current.syncRefs) {
            sheetsAPI.getColumns(sheetId)
              .then(cols => { if (armedFor.current === sheetId) cb.current.syncRefs?.(draft.config, cols) })
              .catch(() => {})
          }
          return
        }
        cb.current.applyConfig(draft.config)
        if (draft.previewResults && draft.previewResults.length > 0) {
          // Array position IS the server's display order (it stored rows by
          // previewIndex) — reassign it so the render keeps that order.
          const rows: AIPreview[] = draft.previewResults.map((r, i) => ({
            rowIndex: r.rowIndex, previewIndex: i, value: r.value,
            error: r.error, promptTokens: r.promptTokens, completionTokens: r.completionTokens,
          }))
          cb.current.applyPreview(rows, draft.runTargetRows ?? 0)
        }
      })
      .catch(() => { /* hydration is best-effort — blank modal is the fallback */ })
  }, [isOpen, sheetId])
}
