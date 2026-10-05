import React from 'react'
import { Pause, Play, Square } from 'lucide-react'
import { AIRun, Step } from './types'

// Step → header subtitle. Passed to DrawerHeader's `description`.
export const subtitleFor = (step: Step) => ({
  configure: 'Configure your AI column settings',
  preview: 'Preview results',
  run: 'Running AI processing',
}[step])

interface Props {
  step: Step
  currentRun: AIRun | null
  onPause: () => void | Promise<void>
  onResume: () => void | Promise<void>
  onCancel: () => void | Promise<void>
}

// The right-hand controls for the AI Column drawer header (run pause/resume/cancel).
// Rendered into DrawerHeader's `headerRight` slot; the title/icon/subtitle and close
// button are owned by DrawerHeader itself now. Mirrors http-modal/HTTPHeaderControls.
export const AIHeaderControls: React.FC<Props> = ({ step, currentRun, onPause, onResume, onCancel }) => {
  if (step !== 'run' || !currentRun) return null
  return (
    <>
      {/* 'pending' is queued-but-not-yet-started; the server pause endpoint
          accepts 'pending'|'running' (ai-control.ts), so a queued run is
          pausable too. Mirrors the sheet-header isPausable (useRunControls). */}
      {(currentRun.status === 'running' || currentRun.status === 'pending') && (
        <button onClick={onPause} className="btn-primary flex items-center gap-1">
          <Pause className="h-4 w-4" />Pause
        </button>
      )}
      {currentRun.status === 'paused' && (
        <button onClick={onResume} className="btn-primary flex items-center gap-1">
          <Play className="h-4 w-4" />Resume
        </button>
      )}
      {(currentRun.status === 'running' || currentRun.status === 'pending' || currentRun.status === 'paused') && (
        <button onClick={onCancel} className="btn-secondary flex items-center gap-1">
          <Square className="h-4 w-4" />Cancel
        </button>
      )}
    </>
  )
}
