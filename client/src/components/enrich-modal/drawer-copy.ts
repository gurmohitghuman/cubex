// The Add enrichment drawer's header words for each step (pure). A run's
// subtitle names its state plainly: running, paused, stopped, failed or ran.
import type { EnrichRunStatus } from '@/utils/api'
import { plural } from '../../lib/utils'
import { ENRICH_TEST_ROWS } from '../../lib/constants'
import type { EnrichDraft, EnrichStep } from './draft'

export function drawerTitle(step: EnrichStep, d: EnrichDraft): string {
  if (step === 'find' || (step === 'setup' && !d.continueColumn)) return 'Add enrichment'
  return step === 'setup' ? 'Edit enrichment' : 'Enrichment'
}

export function drawerSubtitle(step: EnrichStep, d: EnrichDraft, s: EnrichRunStatus | null): string {
  if (step === 'find') return 'Pick what you want to find'
  if (step === 'setup') return `Set up ${d.card?.title ?? ''}`
  if (step === 'test') return `Check the first ${plural(s?.totalRows || s?.test || ENRICH_TEST_ROWS, 'row')}`
  if (!s) return 'Loading the run'
  if (s.status === 'paused') return `${s.toolName}, paused`
  if (s.status === 'cancelled') return `${s.toolName}, stopped`
  if (s.status === 'failed') return `${s.toolName}, failed`
  return s.status === 'completed' ? `Ran ${s.toolName}` : `Running ${s.toolName}`
}
