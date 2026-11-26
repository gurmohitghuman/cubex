import { api } from './client'
import type { Table } from './types'

// Social research tables (server routes/social.ts, services/social-*.ts).
const noServerToast = { skipServerErrorToast: true } as const

export type SocialPlatform = 'tiktok' | 'instagram' | 'youtube' | 'x'
export type SocialStep = 'transcript' | 'breakdown' | 'creator' | 'usual' | 'comments'

// A platform offered now: what one search costs, and each step a post (null: no known price; creator 0: the search
// gives the followers already).
export interface SocialPlatformOption {
  platform: SocialPlatform; label: string; searchUsd: number | null
  steps: { transcript: number | null; creator: number | null; usual: number | null; comments: number | null }
}
export interface SocialView {
  id: string; table_id: string; topic: string; searches_sheet_id: string; comments_sheet_id: string | null
  posts_sheets: Partial<Record<SocialPlatform, string>>; steps: SocialStep[]
  filters: { min_views: number | null; min_comments: number | null; posted_within_days: number | null }
  created_at: string
}
export interface SocialInput {
  topic: string; searches?: string[]; platforms: SocialPlatform[]; steps: SocialStep[]
  minViews?: number | null; minComments?: number | null; postedWithinDays?: number | null
}
export interface FindEstimate {
  searches: number; postsUpTo: number; lowUsd: number; highUsd: number; priceKnown: boolean
  platforms: Array<{ platform: SocialPlatform; column: string; rows: number; lowUsd: number; highUsd: number }>
}

const timeZone = (): string | undefined => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return undefined }
}

export const socialAPI = {
  options: (): Promise<SocialPlatformOption[]> =>
    api.get('/social-research/options', noServerToast).then(res => res.data.platforms),
  create: (input: SocialInput): Promise<Table & { sheetId: string; social: SocialView }> =>
    api.post('/social-research', input, { ...noServerToast, timeout: 60_000 }).then(res => res.data),
  estimate: (id: string): Promise<FindEstimate> =>
    api.post(`/social-research/${id}/find-posts`, { estimateOnly: true }, noServerToast).then(res => res.data.estimate),
  find: (id: string, maxCostUsd: number): Promise<{ day: string; runs: Array<{ platform: SocialPlatform }> }> =>
    api.post(`/social-research/${id}/find-posts`, { maxCostUsd, timeZone: timeZone() }, noServerToast)
      .then(res => res.data),
}
