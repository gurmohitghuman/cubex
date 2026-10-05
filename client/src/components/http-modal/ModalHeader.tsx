import React from 'react'
import { BookOpen, Pause, Play, Square } from 'lucide-react'
import { HTTPRun } from '@/utils/api'
import { Step } from './types'

// Step → header subtitle. Passed to DrawerHeader's `description`.
export const subtitleFor = (step: Step) => ({
  configure: 'Configure your HTTP API request',
  preview: 'Preview results',
  run: 'Running HTTP API processing',
  review: 'Review and commit results',
}[step])

interface Props {
  step: Step
  currentRun: HTTPRun | null
  onShowTemplateModal: () => void
  onPause: () => void | Promise<void>
  onResume: () => void | Promise<void>
  onCancel: () => void | Promise<void>
}

// The right-hand controls for the HTTP API drawer header (Templates button +
// run pause/resume/cancel). Rendered into DrawerHeader's `headerRight` slot; the
// title/icon/subtitle and close button are owned by DrawerHeader itself now.
export const HTTPHeaderControls: React.FC<Props> = ({
  step, currentRun, onShowTemplateModal, onPause, onResume, onCancel,
}) => (
  <>
    {step === 'configure' && (
      <button onClick={onShowTemplateModal}
        className="flex items-center gap-1 px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors"
        title="Load from template">
        <BookOpen className="h-4 w-4" />Templates
      </button>
    )}
    {step === 'run' && currentRun && (
      <>
        {/* 'pending' is queued-but-not-yet-started; the server pause endpoint
            accepts 'pending'|'running' (http-jobs.ts), so a queued run is
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
    )}
  </>
)
