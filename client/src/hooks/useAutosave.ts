import { useEffect, useRef, useState } from 'react'

// Thrown by a `save` whose target is busy rather than failing (a sheet in the
// middle of a sort or import): the same edits are sent again after
// `retryAfterMs`, as many times as it takes.
export class RetryLaterError extends Error {
  constructor(message: string, readonly retryAfterMs: number) {
    super(message)
  }
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

interface Options<T> {
  // Items to save. When this array becomes non-empty, the hook schedules a save.
  pending: T[]
  // The actual save function. Receives the current pending items, should resolve when done.
  save: (items: T[]) => Promise<void>
  // Called after a successful save so the caller can clear the items it sent.
  onSaved: (savedItems: T[]) => void
  // How long to wait after the last change before flushing (debounce).
  debounceMs?: number
  // How long to leave the "Saved" status visible before fading back to idle.
  savedFadeMs?: number
  // Max consecutive failures before surfacing 'error' status to the user.
  maxAttempts?: number
}

// Google-Sheets-style autosave:
//   - debounces rapid edits into one save
//   - shows status (saving / saved / error) for the UI to render
//   - retries failed saves with exponential backoff up to maxAttempts
//   - keeps pending items intact when a save fails so nothing is lost
export function useAutosave<T>({
  pending,
  save,
  onSaved,
  debounceMs = 100,
  savedFadeMs = 1500,
  maxAttempts = 3,
}: Options<T>) {
  const [status, setStatus] = useState<SaveStatus>('idle')
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inflightRef = useRef(false)
  const attemptsRef = useRef(0)
  // Mirror status in a ref so async flow inside flush() reads the CURRENT value,
  // not the value closed over when flush was created. Without this, the
  // reschedule guard below reads a stale `status` (never 'error'), so on a
  // persistent save failure it re-arms at the flat debounce — a ~10 req/s flood
  // with no backoff that self-trips the global rate limiter and locks the user
  // out of every route, including login.
  const statusRef = useRef<SaveStatus>('idle')
  const setSaveStatus = (s: SaveStatus) => { statusRef.current = s; setStatus(s) }
  // Always reflect the latest props inside async callbacks without re-subscribing the effect.
  const pendingRef = useRef(pending)
  const saveRef = useRef(save)
  const onSavedRef = useRef(onSaved)
  pendingRef.current = pending
  saveRef.current = save
  onSavedRef.current = onSaved

  // Tracks the in-flight/scheduled backoff retry so unmount can cancel it.
  // Without this the backoff setTimeout survives unmount and fires flush()
  // against whatever sheet is active by then — the cross-sheet save hazard.
  const backoffTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // While > 0, flushes are suppressed (edits still queue). Used to freeze the
  // queue during a column rename's server round-trip: a straggler edit on the
  // OLD column name must not reach the server after the rename commits, or the
  // upsert resurrects the old column. The caller remaps the queued edits to the
  // new name, then unpauses. A COUNTER, not a boolean, so two overlapping
  // renames compose — the pause lifts only when the LAST one unpauses; a plain
  // boolean would let the first finally() unpause while the other is still in
  // flight, re-opening the resurrection window.
  const pauseCountRef = useRef(0)

  const flush = async () => {
    if (inflightRef.current) return
    // Any entry into flush() supersedes a pending backoff retry: this call IS the
    // retry (or a fresh flush that overtakes it). Clear the old timer so it can't
    // fire later and force-reset inflightRef mid-save → a second concurrent flush
    // (double-flush of the same snapshot). Without this, flushNow()/retry() racing
    // a scheduled backoff leaves two timers live and orphans the first reference,
    // which then survives unmount-cleanup.
    if (backoffTimer.current) {
      clearTimeout(backoffTimer.current)
      backoffTimer.current = null
    }
    // Paused (e.g. during a column rename round-trip): don't hit the network,
    // but if work is queued, show 'saving' so the pill isn't a misleading
    // 'All changes saved' while edits sit un-flushed. They flush on unpause.
    if (pauseCountRef.current > 0) {
      if (pendingRef.current.length > 0) setSaveStatus('saving')
      return
    }
    const snapshot = pendingRef.current
    if (snapshot.length === 0) return

    inflightRef.current = true
    setSaveStatus('saving')

    try {
      await saveRef.current(snapshot)
      onSavedRef.current(snapshot)
      attemptsRef.current = 0
      setSaveStatus('saved')

      if (fadeTimer.current) clearTimeout(fadeTimer.current)
      fadeTimer.current = setTimeout(() => {
        // Only fade to idle if no new pending work has come in.
        if (pendingRef.current.length === 0) setSaveStatus('idle')
      }, savedFadeMs)
    } catch (error) {
      // Not a failure: the server is busy with the target and the save should
      // simply go again later. Retried for as long as that takes, without
      // counting toward maxAttempts or showing an error.
      if (error instanceof RetryLaterError) {
        setSaveStatus('saving')
        backoffTimer.current = setTimeout(() => {
          backoffTimer.current = null
          inflightRef.current = false
          flush()
        }, error.retryAfterMs)
        return
      }
      console.error('Autosave failed:', error)
      attemptsRef.current += 1

      if (attemptsRef.current >= maxAttempts) {
        setSaveStatus('error')
        // Stop here (finally still resets inflight). Don't fall through to the
        // reschedule guard — on a persistent failure that would re-arm the
        // debounce and flood. The user retries by editing again (which resets
        // attempts) or via retry().
        return
      }
      // Exponential backoff: 500ms, 1000ms, 2000ms...
      const backoff = 500 * Math.pow(2, attemptsRef.current - 1)
      setSaveStatus('saving')
      backoffTimer.current = setTimeout(() => {
        backoffTimer.current = null
        inflightRef.current = false
        flush()
      }, backoff)
      return
    } finally {
      inflightRef.current = false
    }

    // If new edits arrived while we were saving, kick off another flush. Read
    // statusRef (current), not the closed-over `status`, so a just-set 'error'
    // is honored.
    if (pendingRef.current.length > 0 && statusRef.current !== 'error') {
      schedule()
    }
  }

  // One-shot send of the current snapshot, used ONLY by unmount. Unlike flush()
  // it does NOT schedule backoff/retry or touch React state — on unmount those
  // would either leave a dangling timer that fires post-unmount or no-op against
  // a gone component. We just put the in-flight edit on the wire (the save path
  // is sheetId-stamped, so it lands correctly regardless of which sheet is now
  // active) and let the localStorage stash + next-load restore cover a failure.
  const flushImmediate = () => {
    if (inflightRef.current || pauseCountRef.current > 0) return
    const snapshot = pendingRef.current
    if (snapshot.length === 0) return
    // Fire and forget — swallow rejection so an unmount-time failure is silent
    // (the stash already preserved it for the next load).
    void Promise.resolve(saveRef.current(snapshot)).catch(() => {})
  }

  const schedule = () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(flush, debounceMs)
  }

  // Reschedule whenever the pending array reference changes.
  useEffect(() => {
    if (pending.length > 0) {
      schedule()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  // Cleanup timers on unmount. The backoff timer especially MUST be cleared:
  // if it survives unmount it fires flush() later, and saveRef.current by then
  // closes over a different sheet — writing one sheet's edits into another.
  useEffect(() => {
    return () => {
      // Flush-on-unmount: an SPA route change (React Router) unmounts the sheet
      // without firing beforeunload, so a still-pending debounced edit would be
      // dropped from the SERVER's view (the debounce timer is cleared below but
      // never fired). flushImmediate() puts it on the wire once — no backoff/retry
      // scheduling (which would leave a timer firing post-unmount) and no React
      // state updates (the component is gone). The save path is sheetId-stamped
      // per item, so it can't cross-write even as activeSheet changes; the XHR
      // outlives the component. (The localStorage stash in useCellOps is the
      // belt-and-suspenders; this is the immediate persist so the edit isn't
      // stranded until the sheet reopens.)
      flushImmediate()
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      if (fadeTimer.current) clearTimeout(fadeTimer.current)
      if (backoffTimer.current) clearTimeout(backoffTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Force a flush now (used by beforeunload + manual retry buttons).
  const flushNow = () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    return flush()
  }

  // Manual retry after error
  const retry = () => {
    attemptsRef.current = 0
    flushNow()
  }

  // Freeze/unfreeze flushing (refcounted — see pauseCountRef). While paused,
  // edits still enqueue but never reach the server. The pause truly lifts only
  // when the count returns to 0, at which point we re-arm the debounce so
  // anything that accumulated (now remapped by the caller) flushes normally.
  const setPaused = (paused: boolean) => {
    pauseCountRef.current = paused
      ? pauseCountRef.current + 1
      : Math.max(0, pauseCountRef.current - 1)
    if (pauseCountRef.current === 0 && pendingRef.current.length > 0) schedule()
  }

  // Whether flushing is currently frozen. Exposed so a flush barrier
  // (waitForSaves) can tell "the queue isn't draining because saves are stuck"
  // (should time out) apart from "the queue is intentionally frozen by a pause"
  // (should keep waiting, not falsely abort). Reads the live ref, so the
  // returned function is safe to capture once.
  const isPaused = () => pauseCountRef.current > 0

  return { status, flushNow, retry, setPaused, isPaused, hasPending: pending.length > 0 }
}
