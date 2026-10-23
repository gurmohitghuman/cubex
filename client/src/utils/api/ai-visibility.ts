import { api } from './client'
import type { Table } from './types'
import { AI_VISIBILITY_CREATE_TIMEOUT_MS } from '@/lib/ai-visibility'

// AI visibility tables (server routes/ai-visibility.ts, services/ai-visibility-*.ts).
const noServerToast = { skipServerErrorToast: true } as const

export interface AiVisibilityView {
  id: string; tableId: string; questionsSheetId: string; sitesSheetId: string | null
  brand: string; competitors: string[]; domain: string | null; country: string; engines: string[]
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
  setBrands: (id: string, brand: string, competitors: string[]): Promise<{ problems: string[] }> =>
    api.put(`/ai-visibility/${id}/brands`, { brand, competitors }, noServerToast).then(res => res.data),
}
