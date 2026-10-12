import { api } from './client'

// "Only run if" rules (server/src/services/run-condition-ai.ts): which model
// "Generate" uses, writing a rule from plain words, and checking a rule on the
// sheet. The rule box shows its own errors in place, so no server toast.
const quiet = { skipServerErrorToast: true } as const

export interface RuleCheck {
  rule: string
  columns: string[]
  rows_checked: number
  rows_passing: number
  rows_skipped: number
  sample: Array<{ row_index: number; values: Record<string, string>; passes: boolean }>
}

export interface GeneratedRule {
  model: string
  model_source: 'picked' | 'sheet' | 'account'
  cost_usd: number | null
  check: RuleCheck
}

export interface RuleModel { model: string | null; source: 'picked' | 'sheet' | 'account' | null }

const base = (sheetId: string) => `/ai/run-conditions/sheets/${sheetId}`

export const runConditionsAPI = {
  model: (sheetId: string): Promise<RuleModel> => api.get(`${base(sheetId)}/model`, quiet).then(r => r.data),
  generate: (sheetId: string, text: string): Promise<GeneratedRule> =>
    api.post(`${base(sheetId)}/generate`, { text }, quiet).then(r => r.data),
  check: (sheetId: string, rule: string, signal?: AbortSignal): Promise<RuleCheck> =>
    api.post(`${base(sheetId)}/check`, { rule }, { ...quiet, signal }).then(r => r.data),
}
