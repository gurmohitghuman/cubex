// The sheet's notice of runs whose rows wait for another run's column (components/sheet/WaitingRunsNotice.tsx),
// pure: one line per run that says it waits (`waiting` on GET /ai/runs and GET /http/runs, read from the
// database on the server), from the run lists the sheet already holds. The line goes to the run that holds the
// column: on this sheet its column, and the drawer of an enrichment or a waterfall; on another sheet (a
// waterfall's lookup step reads one), that sheet first.
import type { AIRun, HTTPRun, RunWaiting } from '@/utils/api'

export interface WaitingLine {
  runId: string
  column: string                         // the column of the run that waits
  words: string                          // the server's message
  rows: number
  // Where the link goes: the holding run, its column, and its sheet and table when that's another sheet.
  holder: {
    runId: string
    kind: RunWaiting['held_by']['run_type']
    column: string | null
    sheetId: string | null
    tableId: string | null
  }
  label: string                          // the link's words
}

function lineOf(runId: string, column: string, w: RunWaiting): WaitingLine {
  const other = !!w.sheet_id && !!w.table_id
  const target = w.held_by.column_name ?? w.column
  return {
    runId, column, words: w.message, rows: w.rows_waiting,
    holder: {
      runId: w.held_by.run_id, kind: w.held_by.run_type, column: w.held_by.column_name,
      sheetId: other ? w.sheet_id! : null, tableId: other ? w.table_id! : null,
    },
    label: other ? `Go to "${target}" on ${w.sheet_name ?? 'its sheet'}` : `Go to "${target}"`,
  }
}

export function waitingLines(aiRuns: AIRun[], httpRuns: HTTPRun[]): WaitingLine[] {
  const lines: WaitingLine[] = []
  for (const r of aiRuns) if (r.waiting) lines.push(lineOf(r.id, r.column_name, r.waiting))
  for (const r of httpRuns) if (r.waiting) lines.push(lineOf(r.id, r.master_column_name ?? 'HTTP API', r.waiting))
  return lines
}

// The first `max` lines, and how many more there are.
export const firstWaiting = (lines: WaitingLine[], max: number): { shown: WaitingLine[]; more: number } =>
  ({ shown: lines.slice(0, max), more: Math.max(0, lines.length - max) })

export const moreWaitingText = (more: number): string => `And ${more} more waiting ${more === 1 ? 'run' : 'runs'}.`
