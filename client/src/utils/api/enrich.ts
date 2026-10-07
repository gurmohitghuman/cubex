import { api } from './client'
import type {
  EnrichEstimate, EnrichEstimateRequest, EnrichSheetSetup, EnrichToolAccess, EnrichToolCard,
  EnrichToolDetail, TregBalance,
} from './types'

// The drawer shows its own error for each of these (inline, in place), so the
// interceptor's generic "Server error occurred" toast stays off.
const noServerToast = { skipServerErrorToast: true } as const

export const enrichAPI = {
  // No query: the Popular jobs. A query searches treg's catalog.
  tools: (q: string, signal?: AbortSignal): Promise<{ featured: boolean; tools: EnrichToolCard[] }> =>
    api.get('/enrich/tools', { ...noServerToast, params: q ? { q } : {}, signal }).then(res => res.data),

  tool: (toolId: string): Promise<EnrichToolDetail> =>
    api.get(`/enrich/tools/${encodeURIComponent(toolId)}`, noServerToast).then(res => res.data.tool),

  // Needs a saved treg key (409 { noKey } without one).
  access: (toolId: string): Promise<EnrichToolAccess> =>
    api.get(`/enrich/tools/${encodeURIComponent(toolId)}/access`, noServerToast).then(res => res.data.access),

  sheetSetup: (sheetId: string): Promise<EnrichSheetSetup> =>
    api.get(`/enrich/sheets/${sheetId}/setup`, noServerToast).then(res => res.data),

  estimate: (body: EnrichEstimateRequest, signal?: AbortSignal): Promise<EnrichEstimate> =>
    api.post('/enrich/estimate', body, { ...noServerToast, signal }).then(res => res.data),

  balance: (): Promise<TregBalance> =>
    api.get('/enrich/balance', noServerToast).then(res => res.data),
}
