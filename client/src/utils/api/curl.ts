import { api } from './client'

// "Paste a cURL command" in the HTTP column dialog (server: services/curl-import-app.ts).
// Mirrors the server's reply shapes.

export interface CurlKeyFinding {
  id: string
  where: string // "Authorization header", "api_key in the URL", "-u user and password"
  kind: 'value' | 'missing' // a key in the command, or a spot that needs one ($OPENAI_API_KEY)
  hint?: string // masked: "sk-p\u20263456"
  placeholder?: string
  suggestedName: string
  existingKey?: string // a saved key that already holds this value
  canDrop: boolean
  basic: boolean // Basic sign-in: a missing one is typed as user and password
  cookie: boolean
}

export type CurlKeyChoice = { save: string; value?: string } | { use: string } | { drop: true }

export interface ImportedRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  url: string
  endpoint: string
  query: Array<{ key: string; value: string }> | null // null: the query stays in the URL
  headers: Array<{ key: string; value: string }>
  body?: string
}

export type CurlImportReply =
  | { needsKeys: true; keys: CurlKeyFinding[]; notes: string[] }
  | { needsKeys: false; request: ImportedRequest; savedKeys: string[]; notes: string[] }

export const curlAPI = {
  // The command can hold keys: errors are shown in place, never as a generic toast.
  importCurl: (sheetId: string, curl: string, keys?: Record<string, CurlKeyChoice>): Promise<CurlImportReply> =>
    api.post('/http/curl', { sheetId, curl, ...(keys ? { keys } : {}) }, { skipServerErrorToast: true })
      .then(res => res.data),
}
