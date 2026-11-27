import { api } from './client'

// Open roles at the companies on a sheet (server routes/open-roles.ts, services/open-roles.ts).
const noServerToast = { skipServerErrorToast: true } as const

export interface OpenRolesOptions {
  websiteColumn: string; roles: string[]; country: string | null; place: string | null
  postedWithinDays: number | null; perCompany: number
}
export interface OpenRolesEstimate {
  // The sheet's rows (one with no website isn't searched, nor paid for).
  companies: number; rolesUpTo: number; priceKnown: boolean; lowUsd: number; highUsd: number
  dailyLimit: { limitUsd: number | null; usedTodayUsd: number; remainingUsd: number | null }
  // The job index's free count over the first companies with a website ("about"): counted, those whose count
  // answered, of asked.
  matches: { about: number; counted: number; asked: number; capped: boolean } | null
}
export interface OpenRolesStarted {
  runId: string; column: string; rolesSheetId: string; rolesSheetName: string
  lookups: string[]; lookupsLeft: string | null
}
// What the sheet's search was last run with (options null: not readable).
export interface OpenRolesSetup {
  options: OpenRolesOptions | null; column: string; rolesSheetId: string; rolesSheetName: string; going: boolean
}

// The day the run stamps on what it finds (First seen) is the person's own.
const timeZone = (): string | undefined => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return undefined }
}

export const openRolesAPI = {
  setup: (sheetId: string): Promise<OpenRolesSetup | null> =>
    api.get(`/open-roles/${sheetId}`, noServerToast).then(res => res.data.setup),
  estimate: (sheetId: string, o: OpenRolesOptions): Promise<OpenRolesEstimate> =>
    api.post(`/open-roles/${sheetId}`, { ...o, estimateOnly: true, timeZone: timeZone() }, noServerToast)
      .then(res => res.data.estimate),
  // maxCostUsd: the most the estimate showed. Over it now (rows or prices changed): 409 with over_ceiling.
  start: (sheetId: string, o: OpenRolesOptions, maxCostUsd: number): Promise<OpenRolesStarted> =>
    api.post(`/open-roles/${sheetId}`, { ...o, timeZone: timeZone(), maxCostUsd }, noServerToast)
      .then(res => res.data.started),
}
