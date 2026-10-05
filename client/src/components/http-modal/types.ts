export interface HTTPAPIConfig {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  endpointUrl: string
  queryParams: Array<{ key: string; value: string }>
  headers: Array<{ key: string; value: string }>
  body?: string
  responseMapping: Array<{ jsonPath: string; columnName: string }>
  previewSize: number
  concurrency: number
  rateLimit?: number
  retries: number
  skipMissingFields: boolean
}

export interface HTTPPreview {
  rowIndex: number
  status: 'success' | 'error' | 'skipped'
  extractedFields: Record<string, any>
  // Raw API response, present on success rows. The ReviewStep tree renders
  // this; the user clicks a leaf to pick which fields commit as columns.
  rawResponse?: any
  requestSummary?: { method: string; url: string }
  error?: string
  reason?: string
}

// 'review' was removed: it never had a render branch (blank modal). Keeping it
// out of the union makes the dead state unrepresentable.
export type Step = 'configure' | 'preview' | 'run'
