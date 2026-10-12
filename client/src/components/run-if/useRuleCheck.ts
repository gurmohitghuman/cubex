import { useEffect, useState } from 'react'
import { runConditionsAPI, type RuleCheck } from '@/utils/api'

const CHECK_DELAY_MS = 500

export type RuleCheckState =
  | { state: 'empty' } | { state: 'checking' } | { state: 'ok'; check: RuleCheck } | { state: 'error'; error: string }

// Checks the rule on the sheet a moment after typing stops (free: no AI), so
// the box can say how many rows will run, or what's wrong with the rule.
export function useRuleCheck(sheetId: string, rule: string, active: boolean): RuleCheckState {
  const [result, setResult] = useState<RuleCheckState>({ state: 'empty' })
  useEffect(() => {
    if (!active) return
    if (!rule.trim()) { setResult({ state: 'empty' }); return }
    setResult({ state: 'checking' })
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      runConditionsAPI.check(sheetId, rule, ctrl.signal)
        .then(check => setResult({ state: 'ok', check }))
        .catch(e => {
          if (ctrl.signal.aborted) return
          setResult({ state: 'error', error: e?.response?.data?.error ?? "Couldn't check the rule." })
        })
    }, CHECK_DELAY_MS)
    return () => { clearTimeout(timer); ctrl.abort() }
  }, [sheetId, rule, active])
  return result
}
