import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { enrichAPI } from '@/utils/api'
import { emptyDraft, type EnrichDraft } from './draft'

// What the grid asks the drawer to open with: a column's enrichment to edit
// ("Edit Enrichment" in the column menu) or a run to watch ("View Run", a pause
// toast's "Show"; the sheet keeps that apart from the draft, useSheetModals).
// The nonce makes a repeat of the same edit open again.
export type EnrichOpenTarget = { kind: 'edit'; column: string } | { kind: 'run'; runId: string }
export type EnrichOpenRequest = { kind: 'edit'; column: string; nonce: number }

type Update = (patch: Partial<EnrichDraft> | ((d: EnrichDraft) => Partial<EnrichDraft>)) => void

// Applies an open request once the drawer is open. Edit reads the column's
// setup from its newest run and opens Set up with it (recall.ts lays it over
// the tool's defaults); a tool treg no longer serves opens Find with its name
// searched, to pick another.
export function useOpenRequest(
  sheetId: string, request: EnrichOpenRequest | null, isOpen: boolean, update: Update, onHandled: () => void,
): { loading: boolean } {
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!request || !isOpen) return
    let alive = true
    setLoading(true)
    enrichAPI.columnSetup(sheetId, request.column)
      .then(setup => {
        if (!alive) return
        if (!setup.card) {
          toast.error(`Can't open ${request.column}: ${setup.toolError ?? "treg's catalog doesn't have its tool."}`)
          update({ ...emptyDraft(), query: setup.choices.toolName })
          return
        }
        // A run still filling the column: Set up follows it and waits.
        const autoRun = !!setup.autorun?.enabled
        update({
          ...emptyDraft(), card: setup.card, step: 'setup', recall: setup.choices,
          continueColumn: request.column, columnName: request.column, runId: setup.activeRunId,
          autoRun, autoRunWas: autoRun, autoRunCapUsd: setup.autorun?.dailyCapUsd ?? null,
        })
      })
      .catch(e => { if (alive) toast.error(e?.response?.data?.error || "Couldn't open this enrichment.") })
      .finally(() => { if (alive) { setLoading(false); onHandled() } })
    return () => { alive = false; setLoading(false) }
  }, [request?.nonce, isOpen]) // eslint-disable-line react-hooks/exhaustive-deps
  return { loading }
}
