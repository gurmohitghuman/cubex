import React, { useMemo } from 'react'
import { Hourglass } from 'lucide-react'
import type { AIRun, HTTPRun } from '@/utils/api'
import { WAITING_NOTICE_MAX_LINES } from '@/lib/constants'
import { firstWaiting, moreWaitingText, waitingLines, type WaitingLine } from '@/lib/waiting-runs'

interface Props {
  // The sheet's runs, as it already loads them (hooks/sheet/useActiveRuns.ts).
  aiRuns: AIRun[]
  httpRuns: HTTPRun[]
  // Go to the run that holds the column: its column (and drawer), on its own sheet first.
  onGo: (line: WaitingLine) => void
}

// Under the sheet header: each run whose rows wait for a column another run holds, the words the server says it
// with (which column, what that run is doing, how many rows wait), and a link to the run that holds it. No
// Resume or Stop here: a paused holder on this sheet that paused itself has its own line with Resume above, and
// the column's menu has the rest.
export const WaitingRunsNotice: React.FC<Props> = ({ aiRuns, httpRuns, onGo }) => {
  const lines = useMemo(() => waitingLines(aiRuns, httpRuns), [aiRuns, httpRuns])
  if (lines.length === 0) return null
  const { shown, more } = firstWaiting(lines, WAITING_NOTICE_MAX_LINES)
  return (
    <div className="mx-4 mt-3 mb-1 border border-gray-200 bg-gray-50 rounded-lg px-3 py-2 text-sm text-gray-800"
      data-testid="waiting-runs-notice" role="status" aria-label="Runs whose rows wait for another run">
      <ul className="divide-y divide-gray-100">
        {shown.map(line => (
          <li key={line.runId} className="flex items-start gap-2 py-1.5" data-testid="waiting-run"
            data-run-id={line.runId} data-holder-id={line.holder.runId}>
            <Hourglass className="h-4 w-4 text-gray-500 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <p className="min-w-0 flex-1 break-words">
              <span className="font-semibold">{line.column}</span> <span>{line.words}</span>
            </p>
            <button type="button" className="text-xs underline hover:no-underline flex-shrink-0 mt-0.5"
              onClick={() => onGo(line)}>
              {line.label}
            </button>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <p className="pt-1.5 text-xs text-gray-600" data-testid="waiting-runs-more">{moreWaitingText(more)}</p>
      )}
    </div>
  )
}
