// The sheet's notice of runs that paused themselves (components/sheet/PausedRunsNotice.tsx), pure: one line
// per run, its column and the words the server saved with the pause (pause_message on GET /ai/runs and
// GET /http/runs), the run lists the sheet already holds. A person's pause has no words and no line.
import type { AIRun, HTTPRun } from '@/utils/api'

export type PausedRunKind = 'ai' | 'http' | 'enrichment' | 'waterfall'

export interface PausedLine {
  runId: string
  kind: PausedRunKind
  column: string
  reason: string
  words: string
  // 'open': the run's own drawer offers the fix, a higher limit, which a plain resume would only meet again (an
  // enrichment at its run or daily limit, a waterfall at its run limit); 'resume': Resume carries it on (an AI
  // run at its spend limit asks for a higher one first, as the header's Resume does).
  action: 'resume' | 'open'
}

// An HTTP run's kind from its config: an enrichment or a waterfall carries its own block.
function httpKind(config: string | null | undefined): PausedRunKind {
  try {
    const c = JSON.parse(config ?? 'null')
    if (c && typeof c.enrichment === 'object' && c.enrichment) return 'enrichment'
    if (c && typeof c.waterfall === 'object' && c.waterfall) return 'waterfall'
  } catch { /* not JSON: a plain HTTP run */ }
  return 'http'
}

// The pauses whose fix is a raise in the run's own drawer (enrich-modal PausedNotice, waterfall RunProgress).
const RAISED_IN_DRAWER: Record<PausedRunKind, ReadonlySet<string>> = {
  ai: new Set(), http: new Set(),
  enrichment: new Set(['spend_limit', 'daily_limit']), waterfall: new Set(['spend_limit']),
}

export function pausedLines(aiRuns: AIRun[], httpRuns: HTTPRun[]): PausedLine[] {
  const lines: PausedLine[] = []
  for (const r of aiRuns) {
    if (r.status !== 'paused' || !r.pause_message) continue
    lines.push({ runId: r.id, kind: 'ai', column: r.column_name, reason: r.pause_reason ?? '', words: r.pause_message,
      action: 'resume' })
  }
  for (const r of httpRuns) {
    if (r.status !== 'paused' || !r.pause_message) continue
    const kind = httpKind(r.config)
    const reason = r.pause_reason ?? ''
    lines.push({ runId: r.id, kind, column: r.master_column_name ?? 'HTTP API', reason, words: r.pause_message,
      action: RAISED_IN_DRAWER[kind].has(reason) ? 'open' : 'resume' })
  }
  return lines
}

// The first `max` lines, and how many more there are.
export const firstLines = (lines: PausedLine[], max: number): { shown: PausedLine[]; more: number } =>
  ({ shown: lines.slice(0, max), more: Math.max(0, lines.length - max) })

export const moreText = (more: number): string => `And ${more} more paused ${more === 1 ? 'run' : 'runs'}.`
