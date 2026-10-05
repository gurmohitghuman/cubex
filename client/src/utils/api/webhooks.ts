import { api } from './client'

const noServerToast = { skipServerErrorToast: true } as const

// Incoming-webhooks API. The management endpoints are sheet-scoped under
// /api/sheets/:id/webhook* (auth via the session cookie). The PUBLIC ingestion
// endpoint (/api/webhooks/:token) is hit by external systems, not the client.

export interface WebhookSource {
  id: string
  sheetId: string
  name: string
  enabled: boolean
  rawColumnName: string
  storeRawMode: string
  totalReceived: number
  lastReceivedAt: string | null
  lastErrorAt: string | null
  lastErrorMessage: string | null
  createdAt: string
  rotatedAt: string | null
  masked: boolean
  // Full URL is present only while the reveal window is open (before the first
  // event), null once masked. Includes the secret token in the path.
  url: string | null
}

export interface WebhookMapping {
  id: string
  jsonPath: string
  columnName: string
  valueMode: 'scalar' | 'json'
  createdAt: string
}

export interface WebhookDelivery {
  id: string
  rowId: string | null
  retained: boolean
  payload: unknown | null
  payloadBytes: number
  status: 'stored' | 'partial' | 'pruned' | 'error'
  errorMessage: string | null
  receivedAt: string
}

export interface WebhookState {
  source: WebhookSource | null
  mappings: WebhookMapping[]
}

export const webhooksAPI = {
  get: (sheetId: string): Promise<WebhookState> =>
    api.get(`/sheets/${sheetId}/webhook`, noServerToast).then(r => r.data),

  create: (sheetId: string, name?: string): Promise<WebhookState> =>
    api.post(`/sheets/${sheetId}/webhook`, { name }, noServerToast).then(r => r.data),

  rotate: (sheetId: string): Promise<{ source: WebhookSource }> =>
    api.post(`/sheets/${sheetId}/webhook/rotate`, {}, noServerToast).then(r => r.data),

  setEnabled: (sheetId: string, enabled: boolean): Promise<{ source: WebhookSource }> =>
    api.patch(`/sheets/${sheetId}/webhook`, { enabled }, noServerToast).then(r => r.data),

  remove: (sheetId: string): Promise<void> =>
    api.delete(`/sheets/${sheetId}/webhook`, noServerToast).then(() => {}),

  addMapping: (
    sheetId: string, jsonPath: string, columnName: string, valueMode: 'scalar' | 'json' = 'scalar',
  ): Promise<{ mappings: WebhookMapping[] }> =>
    api.post(`/sheets/${sheetId}/webhook/mappings`, { jsonPath, columnName, valueMode }, noServerToast).then(r => r.data),

  deleteMapping: (sheetId: string, mappingId: string): Promise<{ mappings: WebhookMapping[] }> =>
    api.delete(`/sheets/${sheetId}/webhook/mappings/${mappingId}`, noServerToast).then(r => r.data),

  // Recent deliveries (newest first) for the sample picker.
  recentDeliveries: (sheetId: string, limit?: number): Promise<{ deliveries: WebhookDelivery[] }> =>
    api.get(`/sheets/${sheetId}/webhook-deliveries`, { params: { limit }, ...noServerToast }).then(r => r.data),

  // Raw payload for the row a delivery created (row-level "View payload"). The
  // grid only knows the row's current index, so we look up by index server-side
  // (which resolves to the stable rows.id and then the delivery).
  rawForRowIndex: (sheetId: string, rowIndex: number): Promise<WebhookDelivery> =>
    api.get(`/sheets/${sheetId}/webhook-deliveries/by-row-index/${rowIndex}`, noServerToast).then(r => r.data),

  // Change-poll: resolves when data_version > since OR row_generation moved
  // off sinceRg (long-poll, ~25s hold). Pass an AbortSignal so switching
  // sheets / unmounting can cancel the in-flight request instead of leaving it
  // hanging until the server-side timeout.
  // sinceSk: the table's tab-list key, so a sheet created/renamed/deleted
  // elsewhere resolves the poll too (answers carry the current sheetsKey).
  changes: (sheetId: string, since: number, sinceRg: number | null, sinceSk: string | null, signal?: AbortSignal):
    Promise<{ dataVersion: number; rowGeneration: number; sheetsKey?: string | null; changed: boolean }> =>
    api.get(`/sheets/${sheetId}/changes`, {
      params: {
        since,
        ...(sinceRg === null ? {} : { since_rg: sinceRg }),
        ...(sinceSk === null ? {} : { since_sk: sinceSk }),
      },
      timeout: 35000, signal, ...noServerToast,
    }).then(r => r.data),
}
