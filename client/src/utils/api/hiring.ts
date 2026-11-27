import { api } from './client'
import type { Table } from './types'
import { HIRING_CREATE_TIMEOUT_MS } from '@/lib/hiring'
import type { ColumnRunEstimate } from './column-runs'

// Hiring tables (server routes/hiring.ts, services/hiring-*.ts).
const noServerToast = { skipServerErrorToast: true } as const

export interface HiringCheck {
  id: string; label: string; since: string | null; stage: 'searching' | 'summarizing' | 'done' | 'stopped'
  checkedAt: string; runId: string | null; searches: number; rolesAdded: number; companiesNew: number
  companiesHiringMore: number
  // Companies the table's filters on Companies kept off (no row).
  companiesKeptOff: number; problems: string[]
}
export interface HiringView {
  id: string; tableId: string; companiesSheetId: string; rolesSheetId: string | null; searchesSheetId: string | null
  roles: string[]; country: string | null; place: string | null; postedWithinDays: number | null; createdAt: string
  // Its filters on Companies (1 and none: every company gets a row).
  minRoles: number; leaveOutCompanies: string[]
  // The latest checks, newest first.
  checks: HiringCheck[]
}
export interface HiringInput {
  roles: string[]; country: string; place: string; postedWithinDays: number | null; perSearch: number
  // Lists, or text with commas (server lib/hiring/filters.ts): any of them searches the one job index that takes them.
  descriptionWords?: string; leaveOutDescriptionWords?: string; leaveOutTitleWords?: string
  seniority?: string[]; employmentTypes?: string[]; companies?: string
  // Which companies get a row on Companies (server lib/hiring/company-filters.ts); the search stays the same.
  minRoles?: number; leaveOutCompanies?: string
}
// What a check would do and cost (server services/hiring-check.ts).
export interface HiringPlan {
  label: string; since: string | null; searches: number; column: string; provider: string | null; perSearch: number
}
export interface HiringEstimate {
  searches: number; rolesUpTo: number; priceKnown: boolean; lowUsd: number; highUsd: number
  dailyLimit: { limitUsd: number | null; usedTodayUsd: number; remainingUsd: number | null }
  // The job index's free count of matching roles ("about"), where it has one; leftOut: what it doesn't take.
  matches: { about: number; counted: number; capped: boolean; leftOut: Array<'place'> } | null
}

// The buyer columns on Companies (server services/hiring-buyer.ts): added or not, the titles the search uses, the
// titles a first "Find buyers" starts with.
// catchAll: Buyer email keeps catch-all addresses too (off until chosen).
export interface HiringBuyer { added: boolean; titles: string[]; starting: string[]; catchAll: boolean }
// A find's answer: the estimate, or the started column run; saved: the setups it saved, titles: the titles in use.
export type FindBuyersAnswer = ({ estimate: ColumnRunEstimate } | { setup_run: { id: string } })
  & { saved: string[]; titles: string[]; buyer: HiringBuyer }

// The day a check stamps on what it finds is the person's own.
const timeZone = (): string | undefined => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return undefined }
}

export const hiringAPI = {
  create: (input: HiringInput): Promise<Table & { sheetId: string; hiring: HiringView }> =>
    api.post('/hiring', input, { ...noServerToast, timeout: HIRING_CREATE_TIMEOUT_MS }).then(res => res.data),
  get: (id: string): Promise<HiringView> => api.get(`/hiring/${id}`, noServerToast).then(res => res.data.hiring),
  buyer: (id: string): Promise<HiringBuyer> => api.get(`/hiring/${id}`, noServerToast).then(res => res.data.buyer),
  // The estimate (a pure read), or the run under maxCostUsd (the most the estimate showed; over it now: 409 with
  // over_ceiling), which saves the buyer columns (or new titles) when needed.
  findBuyers: (id: string, body: { titles: string; estimateOnly: boolean; maxCostUsd?: number; catchAll?: boolean })
    : Promise<FindBuyersAnswer> => api.post(`/hiring/${id}/buyers`, body, noServerToast).then(res => res.data),
  estimate: (id: string): Promise<{ plan: HiringPlan; estimate: HiringEstimate }> =>
    api.post(`/hiring/${id}/check`, { estimateOnly: true, timeZone: timeZone() }, noServerToast)
      .then(res => res.data),
  // Its filters on Companies, from the next check (either or both; refusals come back as 400 or 409).
  setFilters: (id: string, f: { minRoles: number; leaveOutCompanies: string }): Promise<HiringView> =>
    api.patch(`/hiring/${id}`, f, noServerToast).then(res => res.data.hiring),
  // maxCostUsd: the most the estimate showed. Over it now (searches or prices changed): 409 with over_ceiling.
  check: (id: string, maxCostUsd: number): Promise<{ check: HiringCheck; hiring: HiringView }> =>
    api.post(`/hiring/${id}/check`, { timeZone: timeZone(), maxCostUsd }, noServerToast).then(res => res.data),
}
