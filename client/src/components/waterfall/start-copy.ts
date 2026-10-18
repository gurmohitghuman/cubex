// What the Waterfall drawer's confirm says before a start (pure): the first
// rows, every row in scope, or a dry run (of one step, or all of them) on a
// few rows, each with what it can cost.
import { ENRICH_TEST_ROWS } from '@/lib/constants'
import type { WaterfallEstimate } from '@/utils/api/waterfall'
import { formatCost } from '@/components/ai-modal/format'

export type StartChoice = { kind: 'test' } | { kind: 'all' } | { kind: 'dry'; only: string | null }

const money = (v: number) => (v === 0 ? '$0' : formatCost(v))
const BILLS = 'Enrichment steps bill your treg balance, AI steps OpenRouter.'

export function startCopy(c: StartChoice, e: WaterfallEstimate, dryRows: number): { title: string; text: string } {
  if (c.kind === 'test') {
    return {
      title: 'Run on the first rows',
      text: `Run the first ${ENRICH_TEST_ROWS} rows: at most ${money(e.per_row.max_usd * ENRICH_TEST_ROWS)}. ${BILLS}`,
    }
  }
  if (c.kind === 'all') {
    return {
      title: 'Run the waterfall',
      text: `Run ${e.rows.toLocaleString()} rows: about ${money(e.total.average_usd)}, at most `
        + `${money(e.total.max_usd)}. ${BILLS}`,
    }
  }
  const step = c.only ? e.steps.find(s => s.id === c.only) : undefined
  const perRow = step ? step.max_usd : e.per_row.max_usd
  return {
    title: step ? `Test ${step.label}` : 'Try it on a few rows',
    text: `${step ? `${step.label} alone` : 'Every step'} on ${dryRows} rows, for real: at most `
      + `${money(perRow * dryRows)}. Nothing is written to the sheet, and for 7 days a real run replays what it `
      + `found at $0. ${BILLS}`,
  }
}
