import { useEffect, useState } from 'react'
import { runConditionsAPI, type RuleCheck } from '@/utils/api'
import { useTypedReads } from '@/hooks/useTypedReads'
import { readError } from '@/lib/typedReads'

export type RuleCheckState =
  | { state: 'empty' } | { state: 'checking' } | { state: 'ok'; check: RuleCheck } | { state: 'error'; error: string }

// Checks the rule on the sheet as it is typed (free: no AI), so the box can say how many rows will run, or what's
// wrong with the rule. A read of the whole sheet that the server finishes even when dropped: paced by its own
// time, one at a time (lib/typedReads.ts), "checking" from the first key.
export function useRuleCheck(sheetId: string, rule: string, active: boolean): RuleCheckState {
  const [result, setResult] = useState<RuleCheckState>({ state: 'empty' })
  const ask = useTypedReads<RuleCheck>(a => setResult(a.ok ? { state: 'ok', check: a.value }
    : { state: 'error', error: readError(a.error, "Couldn't check the rule.") }), { paced: true })
  useEffect(() => {
    if (!active) return
    const text = rule.trim()
    if (!text) { setResult({ state: 'empty' }); ask('', null); return }
    setResult({ state: 'checking' })
    ask(`${sheetId}\n${rule}`, signal => runConditionsAPI.check(sheetId, rule, signal))
  }, [sheetId, rule, active, ask])
  return result
}
