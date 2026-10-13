// Auto-run for enrichment and HTTP API columns (server services/autorun-*.ts).
// Keep in step with server services/autorun-view.ts and autorun-estimate.ts.

export interface AutorunCondition { column: string; op: string; value: string }

// Why a column's auto-run is paused. 'user': paused on purpose. The caps
// (column_cap, row_cap, daily_limit) lift at midnight UTC or on a raise; treg's
// stops (and 'queue', a run that couldn't be queued) are retried a few minutes
// on; missing_input lifts when the column is back. 'priced': treg prices a tool
// the team's own key billed, and the column needs a daily cap. 'loop': rows it
// adds would set off auto-run that adds rows back (lifts once that one is off).
export type AutorunPause =
  | 'user' | 'column_cap' | 'row_cap' | 'daily_limit' | 'no_key' | 'auth' | 'balance' | 'treg_cap' | 'team_rule'
  | 'provider_busy' | 'unreachable' | 'unconfirmed' | 'retired' | 'missing_input' | 'setup' | 'failed' | 'queue'
  | 'dest_full' | 'priced' | 'loop'

export interface AutorunColumn {
  column: string
  kind: 'enrichment' | 'http'
  enabled: boolean
  pausedReason: AutorunPause | null
  pausedMessage: string | null
  where: AutorunCondition[]
  // Its "Only run if" rule (older condition lists come as one).
  runIf: string | null
  dailyCapUsd: number | null
  dailyRowCap: number | null
  usedTodayUsd: number
  rowsToday: number
}

export interface SheetAutorun {
  columns: Record<string, AutorunColumn>
  hasWebhook: boolean
}

// The dialog's column: the columns its runs fill ("Only run if" can't read
// them), and whether the team's own provider key bills its tool (no dollar cap).
// runIf: the newest run's "Only run if" (a first turn-on starts from it).
export interface AutorunTargetInfo { outputs: string[]; ownKey: boolean; runIf: string | null }

// What an enrichment column spent over all its runs, and on how many rows.
export interface ColumnSpend { spentUsd: number; rows: number }

export interface AutorunSave {
  column: string
  enabled: boolean
  where?: AutorunCondition[] | null
  // undefined keeps the rule (or, on a first turn-on, takes the run's); '' clears it.
  runIf?: string
  dailyCapUsd?: number | null
  dailyRowCap?: number | null
}

export interface AutorunRowsEstimate {
  column: string
  kind: 'enrichment' | 'http'
  rows: number
  lowUsd: number | null
  highUsd: number | null
  dailyCapUsd: number | null
  dailyRowCap: number | null
  // Paused by the person (it runs these rows when resumed) or by a stop that lifts on its own.
  pausedBy: 'user' | 'system' | null
  // treg's catalog didn't give the price in time (the Run confirm doesn't wait for it).
  priceTimedOut?: boolean
}
