import { api } from './client'
import type { AIDraft, AIPreview, AIResult, AIRun, HTTPPreview, HTTPResult, HTTPRun } from './types'
import { previewStream } from './ai-preview-stream'

// Every consumer of these AI/HTTP helpers has its own catch block that surfaces a
// specific, actionable message (`error.response?.data?.error || …`). Opt these
// requests out of the interceptor's generic "Server error occurred" toast so a 5xx
// doesn't stack a useless second toast on top of the caller's message. Spread into
// each request config below. Background pollers (useActiveRuns) that only log are
// also better off without the generic toast.
const noServerToast = { skipServerErrorToast: true } as const

type AIRunParams = {
  sheetId: string
  columnName: string
  prompt: string
  systemPrompt?: string
  model?: string
  temperature?: number
  useOpenRouterWebSearch?: boolean // enable OpenRouter's web_search server tool
  useWebFetch?: boolean            // enable OpenRouter's web_fetch (scoped to /column-derived hosts)
  maxChars?: number
  previewSize?: number
  concurrency?: number
}

export const aiAPI = {
  // Streaming preview (NDJSON over fetch) lives in ./ai-preview-stream — re-exported
  // here so callers keep the single aiAPI surface. The old non-streaming `preview`
  // helper was removed: /ai/preview now ONLY speaks NDJSON, so an axios JSON call
  // would mis-parse the stream. previewStream is the sole client entry point.
  previewStream,

  // reusedRows: how many previewed rows the server promoted into this run
  // instead of re-billing them (credit reuse — 0 when no valid draft matched).
  startRun: (params: AIRunParams): Promise<{ runId: string; message: string; reusedRows?: number }> =>
    api.post('/ai/run', params, noServerToast).then(res => res.data),

  // Persisted modal draft (config + last complete preview). Written by the
  // server during /ai/preview; Back and run-start delete it.
  getDraft: (sheetId: string): Promise<AIDraft | null> =>
    api.get(`/ai/drafts/${sheetId}`, noServerToast).then(res => res.data.draft ?? null),

  deleteDraft: (sheetId: string): Promise<void> =>
    api.delete(`/ai/drafts/${sheetId}`, noServerToast).then(() => {}),

  getRun: (id: string): Promise<{ run: AIRun; results: AIResult[] }> =>
    api.get(`/ai/runs/${id}`, noServerToast).then(res => res.data),

  getRuns: (sheetId: string): Promise<AIRun[]> =>
    api.get(`/ai/runs`, { params: { sheetId }, ...noServerToast }).then(res => res.data),

  pauseRun: (id: string): Promise<void> => api.post(`/ai/runs/${id}/pause`, null, noServerToast).then(() => {}),
  resumeRun: (id: string): Promise<void> => api.post(`/ai/runs/${id}/resume`, null, noServerToast).then(() => {}),
  cancelRun: (id: string): Promise<void> => api.post(`/ai/runs/${id}/cancel`, null, noServerToast).then(() => {}),

  // updateResult/commitResults were removed with the vestigial review step —
  // the run writes rows.data live, so there is nothing to accept or commit.
  // The server routes (/ai/results/:id, /ai/runs/:id/commit) remain as
  // defense-in-depth but have no client callers.

  // The sources behind one "(Data)" cell, looked up by the cell itself.
  getCellSources: (sheetId: string, rowIndex: number, column: string): Promise<{ scrapedData: any[] | null }> =>
    api.get(`/ai/sheets/${sheetId}/sources`, { ...noServerToast, params: { row_index: rowIndex, column } }).then(res => res.data),

  // rowGeneration (optional): sent with a rowIndices selection so the server can
  // 409 if a sort/CSV-replace re-meant the indices since the user selected them.
  // opts.columnName: the exact header clicked, so the server reruns the run that
  // owns it instead of guessing from the base name. opts.mode: which rows
  // (the server's default is 'missing').
  rerun: (
    sheetId: string, baseColumnName: string,
    opts: { rowIndices?: number[]; rowGeneration?: number; columnName?: string; mode?: 'errored' | 'empty' | 'missing' | 'all' } = {},
  ): Promise<{ runId: string; message: string; targetRows: number }> =>
    api.post('/ai/rerun', { sheetId, baseColumnName, ...opts }, noServerToast).then(res => res.data),
}

export const httpAPI = {
  preview: (sheetId: string, config: any): Promise<{ previewResults: HTTPPreview[]; totalRows: number }> =>
    api.post('/http/preview', { sheetId, config }, { timeout: 120000, ...noServerToast }).then(res => res.data),

  startRun: (sheetId: string, config: any, masterColumnName?: string): Promise<{ runId: string; message: string }> =>
    api.post('/http/run', { sheetId, config, masterColumnName }, noServerToast).then(res => res.data),

  // Re-run an existing HTTP column (master column already created). mode='missing'
  // targets empty/❌/⏳ rows; rowIndices targets a selection; neither → all rows.
  rerun: (
    sheetId: string, masterColumnName: string,
    opts?: { mode?: 'missing'; rowIndices?: number[]; rowGeneration?: number },
  ): Promise<{ runId: string; message: string; targetRows: number }> =>
    api.post('/http/rerun', { sheetId, masterColumnName, mode: opts?.mode, rowIndices: opts?.rowIndices, rowGeneration: opts?.rowGeneration }, noServerToast).then(res => res.data),

  controlRun: (jobId: string, action: 'pause' | 'resume' | 'cancel'): Promise<{ message: string }> =>
    api.post(`/http/jobs/${jobId}/control`, { action }, noServerToast).then(res => res.data),

  // Server returns the run flattened with a `results` array — we reshape to
  // {run, results} so callers can destructure cleanly. Without this the modal's
  // `const { run, results } = await httpAPI.getRun(...)` got both undefined.
  getRun: (jobId: string): Promise<{ run: HTTPRun; results: HTTPResult[] }> =>
    api.get(`/http/jobs/${jobId}`, noServerToast).then(res => {
      const { results, ...run } = res.data
      return { run: run as HTTPRun, results: (results || []) as HTTPResult[] }
    }),

  getRuns: (sheetId: string): Promise<HTTPRun[]> =>
    api.get('/http/runs', { params: { sheetId }, ...noServerToast }).then(res => res.data),

  // Template management
  getTemplates: (search?: string): Promise<any[]> =>
    api.get('/http/templates', { params: { search }, ...noServerToast }).then(res => res.data),

  getTemplate: (id: string): Promise<any> =>
    api.get(`/http/templates/${id}`, noServerToast).then(res => res.data),

  createTemplate: (template: { name: string; description?: string; config: any; tags?: string; is_draft?: boolean }): Promise<any> =>
    api.post('/http/templates', template, noServerToast).then(res => res.data),

  updateTemplate: (id: string, template: { name?: string; description?: string; config?: any; tags?: string; is_draft?: boolean }): Promise<any> =>
    api.put(`/http/templates/${id}`, template, noServerToast).then(res => res.data),

  deleteTemplate: (id: string): Promise<void> =>
    api.delete(`/http/templates/${id}`, noServerToast).then(() => {}),

  useTemplate: (id: string): Promise<void> =>
    api.post(`/http/templates/${id}/use`, null, noServerToast).then(() => {}),

  // AI Generate: server uses OpenRouter (optionally with web_fetch on docsUrl)
  // to return a filled HTTPAPIConfig the modal can drop into state and preview.
  // Slow: a docs-URL fetch + LLM round trip can take 20-30s.
  generateConfig: (
    params: { goal: string; docsUrl?: string; keyedColumn?: string; sheetId: string },
  ): Promise<{ config: any; notes?: string }> =>
    api.post('/http/generate-config', params, { timeout: 60000, ...noServerToast }).then(res => res.data),

  // AI Troubleshoot: send the failed request shape + the upstream errors back
  // to the model and get a corrected config + a one-sentence explanation.
  // Auth/secret values in headers are redacted server-side before reaching
  // the model.
  troubleshootConfig: (
    params: { goal?: string; sheetId: string; currentConfig: any; errorSamples: any[] },
  ): Promise<{ config: any; explanation: string }> =>
    api.post('/http/troubleshoot-config', params, { timeout: 60000, ...noServerToast }).then(res => res.data),
}
