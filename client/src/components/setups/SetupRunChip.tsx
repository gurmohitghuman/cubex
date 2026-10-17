import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Bookmark, Pause, Play, Square } from 'lucide-react'
import toast from 'react-hot-toast'
import { setupsAPI, type SetupRunView } from '@/utils/api/setups'
import { onSetupStarted } from '@/lib/setup-runs-signal'

// While a setup works, how often the chip looks again (its runs stream into the grid on their own).
const LIVE_POLL_MS = 2500
const isLive = (r: SetupRunView) => r.status === 'running' || r.status === 'paused'

// The sheet header's chip while a setup is being used on the sheet: its name,
// the step it's on, pause or resume, stop. When it ends, a toast says how
// (and that using it again carries on after a failure).
// onProgress: a setup moved to its next step or ended, so the sheet reloads
// into its new columns at once instead of at the next change poll.
// dataVersion: the sheet's; when it moves, the chip looks again, so a setup an
// agent started (its first columns bump it) shows up without a reload.
export const SetupRunChip: React.FC<{ sheetId: string | null; dataVersion?: number; onProgress?: () => void }> = ({
  sheetId, dataVersion, onProgress,
}) => {
  const [live, setLive] = useState<SetupRunView | null>(null)
  const watching = useRef(new Map<string, string>())
  const progress = useRef(onProgress)
  progress.current = onProgress
  const current = useRef(sheetId)
  current.current = sheetId

  const look = useCallback(async () => {
    if (!sheetId) return
    let runs: SetupRunView[]
    try { runs = await setupsAPI.runs(sheetId) } catch { return }
    if (current.current !== sheetId) return // another sheet opened meanwhile
    let moved = false
    for (const r of runs) {
      const seen = watching.current.get(r.id)
      if (isLive(r)) {
        if (seen !== undefined && seen !== `${r.layer}`) moved = true
        watching.current.set(r.id, `${r.layer}`)
      } else if (watching.current.delete(r.id)) {
        moved = true
        if (r.status === 'done') toast.success(`"${r.setup_name}" is done.`)
        else if (r.status === 'failed') {
          toast.error(`"${r.setup_name}" stopped: ${r.error_message ?? 'a step failed'} `
            + 'Use the setup again here to carry on from where it stopped.')
        }
      }
    }
    if (moved) progress.current?.()
    setLive(runs.find(isLive) ?? null)
  }, [sheetId])

  useEffect(() => {
    watching.current = new Map()
    void look()
    return onSetupStarted(id => { if (id === sheetId) void look() })
  }, [sheetId, look])
  useEffect(() => { if (dataVersion !== undefined) void look() }, [dataVersion, look])
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => { void look() }, LIVE_POLL_MS)
    return () => clearInterval(t)
  }, [live, look])

  if (!live) return null
  const act = async (action: 'pause' | 'resume' | 'cancel') => {
    try { setLive(await setupsAPI.control(live.id, action)) } catch (e: any) {
      toast.error(e?.response?.data?.error || "Couldn't change the setup.")
    }
    void look()
  }
  const paused = live.status === 'paused'
  return (
    <div className="flex items-center gap-1.5 ml-2 border border-gray-300 px-2 py-1 text-xs text-gray-700"
      data-testid="setup-run-chip" title={live.steps.map(s => `${s.layer}. ${s.column}: ${s.state}`).join('\n')}>
      <Bookmark className="h-3 w-3" />
      <span className="max-w-[16rem] truncate">
        {live.setup_name}: step {live.layer} of {live.layers}{paused ? ' (paused)' : ''}
      </span>
      <button type="button" className="p-0.5 hover:text-gray-900" onClick={() => void act(paused ? 'resume' : 'pause')}
        aria-label={paused ? 'Resume the setup' : 'Pause the setup'}>
        {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
      </button>
      <button type="button" className="p-0.5 hover:text-red-600" onClick={() => void act('cancel')}
        aria-label="Stop the setup">
        <Square className="h-3 w-3" />
      </button>
    </div>
  )
}
