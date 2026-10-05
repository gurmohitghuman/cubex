import { useEffect, useRef } from 'react'
import { webhooksAPI } from '@/utils/api/webhooks'

export interface ChangeBaseline { dataVersion: number; rowGeneration: number }

// Minimum time per poll cycle, even when every response reports a change.
// Caps the loop at ~20 req/min under a sustained external write burst — well
// inside the global IP limiter's ~66/min average budget, shared with the
// silent reloads the changes trigger (paced separately in useLiveSheetUpdates).
const MIN_CYCLE_MS = 3000

// Live-update for out-of-band writers (webhook appends + every /api/v1
// mutation): long-poll the sheet's data_version + row_generation via
// GET /:id/changes and tell the caller WHAT moved so it can pick the reload:
//   structural=true  → row_generation moved (sort / CSV-replace re-meant every
//                      row_index) → the caller should LOUD-reload unless it
//                      already holds that generation.
//   structural=false → data_version only (appends/edits/deletes/columns) → the
//                      caller's SILENT reload (overlays un-flushed +
//                      recently-acked local edits) is safe.
//
// `baseline` comes from the sheet payload the tab actually rendered (its own
// data_version/row_generation), so a write that lands between the sheet GET
// and the first poll is caught — the first response is already actionable
// (a separate seeding read silently swallowed that window).
// Only the FIRST baseline per sheet is consumed (read via ref when the loop
// starts); afterwards the loop tracks versions from each response, so reloads
// updating the sheet payload don't restart the poll.
//
// One cheap integer read per cycle; NOT a per-tick sheet refetch. Every open
// sheet polls (webhook or not), because /api/v1 can write to any sheet.
//
// The tab list rides the same poll: `sheetList.key` (the table GET's
// sheets_key) goes up as since_sk, and when the answer's sheetsKey differs (a
// sheet created, renamed, reordered or deleted elsewhere), or the open sheet
// itself is gone (404), `sheetList.onChanged` re-reads the table.
export function useSheetChangePoll(
  sheetId: string | null,
  baseline: ChangeBaseline | null,
  onChanged: (sheetId: string, change: { rowGeneration: number; structural: boolean }) => void,
  sheetList?: { key: string | null | undefined; onChanged: () => void },
) {
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged
  const baselineRef = useRef(baseline)
  baselineRef.current = baseline
  const sheetListRef = useRef(sheetList)
  sheetListRef.current = sheetList
  const hasBaseline = baseline !== null

  useEffect(() => {
    if (!sheetId || !hasBaseline) return
    const start = baselineRef.current
    if (!start) return
    let cancelled = false
    let sinceDv = start.dataVersion
    let sinceRg = start.rowGeneration
    let sinceSk = sheetListRef.current?.key ?? null
    const controller = new AbortController()

    const loop = async () => {
      while (!cancelled) {
        const started = Date.now()
        try {
          const res = await webhooksAPI.changes(sheetId, sinceDv, sinceRg, sinceSk, controller.signal)
          if (cancelled) return
          const structural = res.rowGeneration !== sinceRg
          if (structural || (res.changed && res.dataVersion > sinceDv)) {
            onChangedRef.current(sheetId, { rowGeneration: res.rowGeneration, structural })
          }
          if (res.sheetsKey && res.sheetsKey !== sinceSk) {
            if (sinceSk !== null) sheetListRef.current?.onChanged()
            sinceSk = res.sheetsKey
          }
          sinceDv = res.dataVersion
          sinceRg = res.rowGeneration
          // Pacing: a fast unchanged response means the server didn't hold us
          // (over its concurrent-hold cap and degrading gracefully). Sleep
          // instead of hot-looping into the rate limiter.
          const elapsed = Date.now() - started
          if (!res.changed && elapsed < 3000) {
            await new Promise(r => setTimeout(r, 4000))
          } else if (elapsed < MIN_CYCLE_MS) {
            // CHANGED responses resolve the long-poll almost instantly while an
            // external writer (API/MCP agent) is bumping data_version every
            // second — without a floor this loop cycles ~1/s and, with the
            // reload each cycle triggers, burns the tab's global-IP-limiter
            // budget (observed: a 120/min PAT writer 429'd the owner's own UI).
            // data_version is cumulative, so sleeping loses nothing: the next
            // poll sees every write that landed in between.
            await new Promise(r => setTimeout(r, MIN_CYCLE_MS - elapsed))
          }
        } catch (err: any) {
          if (cancelled) return // includes the abort on cleanup
          // The open sheet was deleted (or its table): let the page move on.
          if (err?.response?.status === 404) sheetListRef.current?.onChanged()
          // Backoff on error so a flapping endpoint doesn't hot-loop.
          await new Promise(r => setTimeout(r, 5000))
        }
      }
    }
    void loop()
    // Abort the in-flight long-poll so switching sheets doesn't leave a hanging
    // request (and its server-side interval) open until the 25s timeout.
    return () => { cancelled = true; controller.abort() }
  }, [sheetId, hasBaseline])
}
