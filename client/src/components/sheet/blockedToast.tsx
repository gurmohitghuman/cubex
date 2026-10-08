import React from 'react'
import toast from 'react-hot-toast'
import { aiAPI, httpAPI } from '@/utils/api'

interface BlockingRun { id: string; kind: 'ai' | 'http'; paused: boolean }

// A sort or row delete refused because a run holds the sheet (409). A paused
// run is named with "Cancel it", which stops it (its ⏳ cells clear) so the
// action can go through; auto-run's own refusal just says to try again.
export function toastBlocked(error: any, fallback: string, opts: { id?: string; onCancelled?: () => void } = {}): void {
  const data = error?.response?.data
  const run = data?.blockingRun as BlockingRun | undefined
  const message: string = data?.error ?? fallback
  if (!run?.paused) { toast.error(message, opts.id ? { id: opts.id } : undefined); return }
  const cancel = async (toastId: string) => {
    toast.dismiss(toastId)
    try {
      if (run.kind === 'ai') await aiAPI.cancelRun(run.id)
      else await httpAPI.controlRun(run.id, 'cancel')
      opts.onCancelled?.()
    } catch (e: any) {
      toast.error(e?.response?.data?.error || "Couldn't cancel the run.")
    }
  }
  toast.error(t => (
    <span className="flex items-start gap-3" data-testid="blocked-toast">
      <span>{message}</span>
      <button type="button" className="underline whitespace-nowrap" onClick={() => void cancel(t.id)}>Cancel it</button>
    </span>
  ), { id: opts.id, duration: 10000 })
}
