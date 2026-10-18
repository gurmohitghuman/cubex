import { api } from './client'
import type {
  EnrichEstimate, EnrichEstimateRequest, EnrichSheetSetup, EnrichToolAccess, EnrichToolCard,
  EnrichToolDetail, TregBalance, EnrichRunRequest, EnrichRunStarted, EnrichRunStatus,
  EnrichRowCounts, EnrichRowsScope, EnrichRerunRequest, EnrichRerunEstimate, EnrichColumnSetup, EnrichSpend,
  EnrichReuseCount,
  AnswerView, AnswerFieldAdded, EnrichListField, EnrichListFieldChoices, StoredAnswers,
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

  // Starts a run: creates the columns, then seeds and queues it on the server.
  startRun: (sheetId: string, body: EnrichRunRequest): Promise<EnrichRunStarted> =>
    api.post(`/enrich/sheets/${sheetId}/runs`, body, noServerToast).then(res => res.data),

  // Rows of the run this body would start that reuse an earlier found answer (a pure read).
  reuseCount: (sheetId: string, body: EnrichRunRequest, signal?: AbortSignal): Promise<EnrichReuseCount> =>
    api.post(`/enrich/sheets/${sheetId}/reuse-count`, body, { ...noServerToast, signal }).then(res => res.data),

  runStatus: (runId: string): Promise<EnrichRunStatus> =>
    api.get(`/enrich/runs/${runId}`, noServerToast).then(res => res.data),

  // Resume a paused run, with a higher run limit when its limit paused it.
  resumeRun: (runId: string, spendLimitUsd?: number): Promise<{ ok: true }> =>
    api.post(`/enrich/runs/${runId}/resume`, spendLimitUsd === undefined ? {} : { spendLimitUsd }, noServerToast)
      .then(res => res.data),

  // Rows by status in a column (null: a new column), for a scope.
  // conditions: the run's "Only run if"; rows failing them aren't counted.
  rowCounts: (
    sheetId: string, column: string | null, mode: EnrichRowsScope, rowIndexes?: number[],
    conditions: Array<{ column: string; op: string; value: string }> = [], runIf = '',
  ): Promise<EnrichRowCounts> =>
    api.post(`/enrich/sheets/${sheetId}/row-counts`, {
      column, mode, ...(mode === 'selected' ? { rowIndexes } : {}), ...(conditions.length ? { conditions } : {}),
      ...(runIf.trim() ? { runIf } : {}),
    }, noServerToast).then(res => res.data),

  // The column menu's reruns, and their confirm's figures (a pure read).
  rerun: (sheetId: string, body: EnrichRerunRequest): Promise<EnrichRunStarted> =>
    api.post(`/enrich/sheets/${sheetId}/reruns`, { ...body, estimateOnly: false }, noServerToast).then(res => res.data),

  rerunEstimate: (sheetId: string, body: EnrichRerunRequest): Promise<EnrichRerunEstimate> =>
    api.post(`/enrich/sheets/${sheetId}/reruns`, { ...body, estimateOnly: true }, noServerToast)
      .then(res => res.data.estimate),

  columnSetup: (sheetId: string, column: string): Promise<EnrichColumnSetup> =>
    api.get(`/enrich/sheets/${sheetId}/column-setup`, { ...noServerToast, params: { column } }).then(res => res.data),

  // One cell's stored answer (enrichment and HTTP API columns).
  answer: (sheetId: string, column: string, row: number): Promise<AnswerView> =>
    api.get(`/enrich/sheets/${sheetId}/answer`, { ...noServerToast, params: { column, row } }).then(res => res.data),

  // "+ Column": a new column filled from the stored answers (free).
  addField: (
    sheetId: string, body: { column: string; jsonPath: string; name: string; row: number },
  ): Promise<AnswerFieldAdded> =>
    api.post(`/enrich/sheets/${sheetId}/fields`, body, noServerToast).then(res => res.data),

  // A list column's results: the fields they have (to pick the ones to keep).
  listFields: (sheetId: string, column: string): Promise<EnrichListFieldChoices> =>
    api.get(`/enrich/sheets/${sheetId}/list-fields`, { ...noServerToast, params: { column } }).then(res => res.data),

  // "Add these rows": the fields for results waiting for them.
  pickListFields: (
    sheetId: string, body: { column: string; fields: EnrichListField[]; dedupePath: string | null },
  ): Promise<{ released: number }> =>
    api.post(`/enrich/sheets/${sheetId}/list-fields`, body, noServerToast).then(res => res.data),

  // Results this sheet bought that aren't rows in another sheet yet (null: none).
  resultsNotAdded: (sheetId: string): Promise<{ results: number; sheets: string[] } | null> =>
    api.get(`/enrich/sheets/${sheetId}/results-not-added`, noServerToast).then(res => res.data.notAdded),

  spend: (days: number): Promise<EnrichSpend> =>
    api.get('/enrich/spend', { ...noServerToast, params: { days } }).then(res => res.data),

  // The stored answers' size (a count starts in the background when it's old) and the last prune.
  storedAnswers: (): Promise<StoredAnswers> =>
    api.get('/enrich/stored-answers', noServerToast).then(res => res.data),

  pruneStoredAnswers: (): Promise<StoredAnswers> =>
    api.post('/enrich/stored-answers/prune', {}, noServerToast).then(res => res.data),
}
