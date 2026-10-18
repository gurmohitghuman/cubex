import { api } from './client'

// Descriptions (server routes/sheets-descriptions.ts, services/descriptions.ts):
// a sheet's and a column's, the same ones REST and MCP set. "" clears one. The
// answer is the description as saved (cleaned, or null when cleared).
export const descriptionsAPI = {
  saveSheet: (sheetId: string, description: string): Promise<{ description: string | null }> =>
    api.put(`/sheets/${sheetId}/description`, { description }, { skipServerErrorToast: true })
      .then(res => res.data),
  saveColumn: (sheetId: string, column: string, description: string): Promise<{ description: string | null }> =>
    api.put(`/sheets/${sheetId}/column-description`, { column, description }, { skipServerErrorToast: true })
      .then(res => res.data),
}
