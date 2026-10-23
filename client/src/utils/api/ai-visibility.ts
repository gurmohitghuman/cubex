import { api } from './client'
import type { Table } from './types'
import { AI_VISIBILITY_CREATE_TIMEOUT_MS } from '@/lib/ai-visibility'

// AI visibility tables (server routes/ai-visibility.ts, services/ai-visibility-*.ts).
const noServerToast = { skipServerErrorToast: true } as const

export interface AiVisibilityCheck {
  id: string; label: string; stage: 'copying' | 'comparing' | 'asking' | 'done' | 'stopped'; checkedAt: string
  questionsCopySheetId: string | null; sitesCopySheetId: string | null
  namedByColumn: string; changeColumn: string; runs: Array<{ column: string; runId: string; rows: number }>
  problems: string[]
}
export interface AiVisibilityView {
  id: string; tableId: string; questionsSheetId: string; sitesSheetId: string | null
  brand: string; competitors: string[]; domain: string | null; country: string; engines: string[]
  // When the engines were last asked (null: never), and the latest checks, newest first.
  answersAt: string | null; checks: AiVisibilityCheck[]
}
// What "Check again" would do (server services/ai-visibility-check.ts checkPlan).
export interface CheckPlan {
  label: string; askedAt: string; days: number; soon: boolean; questions: number; engines: string[]
  names: { questionsCopy: string; sitesCopy: string | null; namedBy: string; change: string }
  // A check that stopped, which this one goes on with: its copies stay, and only `engines` are asked.
  picksUp: string | null
}
// The day in a check's names is the person's own.
const timeZone = (): string | undefined => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return undefined }
}
export interface AiVisibilityInput {
  brand: string; competitors: string[]; domain: string; country: string; engines: string[]; questions: string[]
}
export interface AskEstimate {
  engines: Array<{ column: string; rows: number; lowUsd: number; highUsd: number; priceKnown: boolean }>
  rows: number; lowUsd: number; highUsd: number
  problems: string[]
}
export interface AskStarted { started: Array<{ column: string; runId: string; rows: number }>; problems: string[] }

export const aiVisibilityAPI = {
  create: (input: AiVisibilityInput): Promise<Table & { sheetId: string; problems: string[] }> =>
    api.post('/ai-visibility', input, { ...noServerToast, timeout: AI_VISIBILITY_CREATE_TIMEOUT_MS })
      .then(res => res.data),
  estimate: (id: string, again: boolean): Promise<AskEstimate> =>
    api.post(`/ai-visibility/${id}/ask`, { estimateOnly: true, again }, noServerToast).then(res => res.data.estimate),
  ask: (id: string, again: boolean): Promise<AskStarted> =>
    api.post(`/ai-visibility/${id}/ask`, { again }, noServerToast).then(res => res.data),
  // fresh: a new check, not the stopped one it would pick up.
  checkEstimate: (id: string, fresh = false): Promise<{ plan: CheckPlan; estimate: AskEstimate }> =>
    api.post(`/ai-visibility/${id}/check`, { estimateOnly: true, timeZone: timeZone(), fresh }, noServerToast)
      .then(res => res.data),
  // Copies two sheets and fills two columns before it asks: a big table takes a while.
  check: (id: string, fresh = false): Promise<{ check: AiVisibilityCheck }> =>
    api.post(`/ai-visibility/${id}/check`, { timeZone: timeZone(), fresh },
      { ...noServerToast, timeout: AI_VISIBILITY_CREATE_TIMEOUT_MS })
      .then(res => res.data),
  setBrands: (id: string, brand: string, competitors: string[]): Promise<{ problems: string[] }> =>
    api.put(`/ai-visibility/${id}/brands`, { brand, competitors }, noServerToast).then(res => res.data),
}
