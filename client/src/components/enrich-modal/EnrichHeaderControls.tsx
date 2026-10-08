import React from 'react'
import { Pause, Play, Square } from 'lucide-react'
import { plainResumeWorks, type EnrichRunControls } from './useEnrichRun'

// Pause / Resume / Cancel for the run the Test or Run step follows, in the
// drawer header's right slot (the AI and HTTP drawers' header controls). A run
// its limit paused gets no Resume here: the step's notice raises the limit and
// resumes (PausedNotice).
export const EnrichHeaderControls: React.FC<{ run: EnrichRunControls }> = ({ run }) => {
  const s = run.status
  if (!s) return null
  const pausable = s.status === 'running' || s.status === 'pending'
  return (
    <>
      {pausable && (
        <button onClick={run.pause} disabled={run.busy} className="btn-primary flex items-center gap-1"
          data-testid="enrich-header-pause">
          <Pause className="h-4 w-4" />Pause
        </button>
      )}
      {plainResumeWorks(s) && (
        <button onClick={() => run.resume()} disabled={run.busy} className="btn-primary flex items-center gap-1"
          data-testid="enrich-header-resume">
          <Play className="h-4 w-4" />Resume
        </button>
      )}
      {(pausable || s.status === 'paused') && (
        <button onClick={run.cancel} disabled={run.busy} className="btn-secondary flex items-center gap-1"
          data-testid="enrich-header-cancel">
          <Square className="h-4 w-4" />Cancel
        </button>
      )}
    </>
  )
}
