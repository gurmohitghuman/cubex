import React, { useMemo, useState } from 'react'
import { PauseCircle } from 'lucide-react'
import type { AIRun, HTTPRun } from '@/utils/api'
import { PAUSED_NOTICE_MAX_LINES } from '@/lib/constants'
import { firstLines, moreText, pausedLines, type PausedLine } from '@/lib/paused-runs'

interface Props {
  // The sheet's active runs, as it already loads them (hooks/sheet/useActiveRuns.ts).
  aiRuns: AIRun[]
  httpRuns: HTTPRun[]
  // Resume this one run (an AI run at its spend limit asks for a higher limit first).
  onResume: (line: PausedLine) => Promise<void>
  // Open the run's own drawer, where its fix is (an enrichment or waterfall at a limit).
  onOpen: (line: PausedLine) => void
}

// Under the sheet header: each run that paused itself, its column, and the words it saved, which say what to
// change before resuming, beside its own Resume. It shows while another run is still going too, when the header
// offers Pause rather than Resume. The words are text, never markup: some carry a provider's own error text.
export const PausedRunsNotice: React.FC<Props> = ({ aiRuns, httpRuns, onResume, onOpen }) => {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const lines = useMemo(() => pausedLines(aiRuns, httpRuns), [aiRuns, httpRuns])
  if (lines.length === 0) return null
  const { shown, more } = firstLines(lines, PAUSED_NOTICE_MAX_LINES)
  const resume = async (line: PausedLine) => {
    setBusy(b => new Set(b).add(line.runId))
    try { await onResume(line) } finally {
      setBusy(b => { const n = new Set(b); n.delete(line.runId); return n })
    }
  }
  return (
    <div className="mx-4 mt-3 mb-1 border border-amber-200 bg-amber-50 rounded-lg px-3 py-2 text-sm text-amber-900"
      data-testid="paused-runs-notice" role="status" aria-label="Runs that paused themselves">
      <ul className="divide-y divide-amber-100">
        {shown.map(line => (
          <li key={line.runId} className="flex items-start gap-2 py-1.5" data-testid="paused-run"
            data-run-id={line.runId} data-reason={line.reason}>
            <PauseCircle className="h-4 w-4 text-amber-700 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <p className="min-w-0 flex-1 break-words">
              <span className="font-semibold">{line.column}</span> paused: <span>{line.words}</span>
            </p>
            {line.action === 'open' ? (
              <button type="button" className="btn-secondary text-xs flex-shrink-0" onClick={() => onOpen(line)}>
                Open
              </button>
            ) : (
              <button type="button" className="btn-secondary text-xs flex-shrink-0" disabled={busy.has(line.runId)}
                onClick={() => { void resume(line) }} aria-label={`Resume ${line.column}`}>
                Resume
              </button>
            )}
          </li>
        ))}
      </ul>
      {more > 0 && <p className="pt-1.5 text-xs text-amber-800" data-testid="paused-runs-more">{moreText(more)}</p>}
    </div>
  )
}
