import { api } from './client'
import type { Table } from './types'
import { HIRING_CREATE_TIMEOUT_MS } from '@/lib/hiring'

// Hiring tables (server routes/hiring.ts, services/hiring-*.ts).
const noServerToast = { skipServerErrorToast: true } as const

export interface HiringCheck {
  id: string; label: string; since: string | null; stage: 'searching' | 'summarizing' | 'done' | 'stopped'
  checkedAt: string; runId: string | null; searches: number; rolesAdded: number; companiesNew: number
  companiesHiringMore: number; problems: string[]
}
export interface HiringView {
  id: string; tableId: string; companiesSheetId: string; rolesSheetId: string | null; searchesSheetId: string | null
  roles: string[]; country: string | null; place: string | null; postedWithinDays: number | null; createdAt: string
  // The latest checks, newest first.
  checks: HiringCheck[]
}
export interface HiringInput {
  roles: string[]; country: string; place: string; postedWithinDays: number | null; perSearch: number
}
// What a check would do and cost (server services/hiring-check.ts).
export interface HiringPlan {
  label: string; since: string | null; searches: number; column: string; provider: string | null; perSearch: number
}
export interface HiringEstimate {
  searches: number; rolesUpTo: number; priceKnown: boolean; lowUsd: number; highUsd: number
  dailyLimit: { limitUsd: number | null; usedTodayUsd: number; remainingUsd: number | null }
  // The job index's free count of matching roles ("about"), where it has one.
  matches: { about: number; counted: number; capped: boolean } | null
}

// The day a check stamps on what it finds is the person's own.
const timeZone = (): string | undefined => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return undefined }
}

export const hiringAPI = {
  create: (input: HiringInput): Promise<Table & { sheetId: string; hiring: HiringView }> =>
    api.post('/hiring', input, { ...noServerToast, timeout: HIRING_CREATE_TIMEOUT_MS }).then(res => res.data),
  get: (id: string): Promise<HiringView> => api.get(`/hiring/${id}`, noServerToast).then(res => res.data.hiring),
  estimate: (id: string): Promise<{ plan: HiringPlan; estimate: HiringEstimate }> =>
    api.post(`/hiring/${id}/check`, { estimateOnly: true, timeZone: timeZone() }, noServerToast)
      .then(res => res.data),
  check: (id: string): Promise<{ check: HiringCheck; hiring: HiringView }> =>
    api.post(`/hiring/${id}/check`, { timeZone: timeZone() }, noServerToast).then(res => res.data),
}
