import { api } from './client'

// Why a "⏭️ Condition not met" cell didn't run (server routes/sheets-skip-why.ts, services/skip-why.ts): each
// "Only run if" rule the row fails now, with each part that fails in plain words. Free, no AI.
export interface SkipWhy {
  rules: Array<{ rule: string; by: 'run' | 'auto_run'; why: string[] }>
  passes_now: boolean
  has_rule: boolean
}

// The words the run writes on a row its rule kept out.
export const CONDITION_NOT_MET = '⏭️ Condition not met'

export const skipWhyAPI = {
  read: (sheetId: string, row: number, column: string): Promise<SkipWhy> =>
    api.get(`/sheets/${sheetId}/skip-why`, { params: { row, column }, skipServerErrorToast: true })
      .then(res => res.data),
}
