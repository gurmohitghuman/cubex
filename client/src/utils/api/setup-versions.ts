import { api } from './client'

// A sheet's setup versions (server routes/sheets-setup-versions.ts,
// services/setup-version-*.ts): how its columns are set up, kept by name,
// compared with the sheet now and restored. Field names match
// /api/v1/sheets/:id/setup-versions and the MCP tools.
export interface SetupVersion {
  id: string
  name: string
  description: string | null
  auto: boolean            // kept by a restore: the setup it replaced
  by: string
  saved_at: string
  columns: number
  filled: number
}

export type ColumnKind =
  'plain' | 'made' | 'ai' | 'http' | 'enrichment' | 'waterfall' | 'clean' | 'formula' | 'lookup'

export interface FieldChange { field: string; version: string | null; now: string | null }

export interface PlannedColumn {
  column: string
  action: 'add_back' | 'restore' | 'keep' | 'leave'
  kind: ColumnKind
  nowKind?: ColumnKind     // 'leave' of a column filled another way now: how it is filled now
  fields: FieldChange[]
  note: string | null
}

export interface RestoreAnswer {
  version: SetupVersion
  dry_run: boolean
  nothing: boolean
  blocked: string | null   // a dry run: why it can't be restored now
  columns: PlannedColumn[]
  unchanged: number
  order_changed: boolean
  saved_before: SetupVersion | null
  message: string
}

export const setupVersionsAPI = {
  list: (sheetId: string): Promise<SetupVersion[]> =>
    api.get(`/sheets/${sheetId}/setup-versions`).then(res => res.data.versions),
  save: (sheetId: string, name: string): Promise<SetupVersion> =>
    api.post(`/sheets/${sheetId}/setup-versions`, { name }, { skipServerErrorToast: true })
      .then(res => res.data.version),
  compare: (sheetId: string, versionId: string): Promise<RestoreAnswer> =>
    api.get(`/sheets/${sheetId}/setup-versions/${versionId}`).then(res => res.data),
  rename: (sheetId: string, versionId: string, name: string): Promise<SetupVersion> =>
    api.patch(`/sheets/${sheetId}/setup-versions/${versionId}`, { name }, { skipServerErrorToast: true })
      .then(res => res.data.version),
  remove: (sheetId: string, versionId: string): Promise<void> =>
    api.delete(`/sheets/${sheetId}/setup-versions/${versionId}`).then(() => {}),
  restore: (sheetId: string, versionId: string): Promise<RestoreAnswer> =>
    api.post(`/sheets/${sheetId}/setup-versions/${versionId}/restore`, {}, { skipServerErrorToast: true })
      .then(res => res.data),
}
