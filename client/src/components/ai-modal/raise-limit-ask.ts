// Whether Resume on a paused AI run should ask for a higher spend limit
// (RaiseLimitDialog) instead of resuming: the run paused at its limit, or it
// was paused another way (by you, say) once its limit was used up, which the
// light read says (raise-limit.ts limitUsedUp). A run without a limit never
// asks and reads nothing. A read that fails resumes as usual (the server
// still refuses a resume with no room, saying why).
import { aiAPI } from '@/utils/api'
import { limitUsedUp } from './raise-limit'

interface PausedRun { id: string; pause_reason?: string | null; spend_limit_usd?: number | null }

export async function asksForHigherLimit(run: PausedRun): Promise<boolean> {
  if (run.pause_reason === 'spend_limit') return true
  if (typeof run.spend_limit_usd !== 'number') return false
  try { return limitUsedUp(await aiAPI.spendLimit(run.id)) } catch { return false }
}
