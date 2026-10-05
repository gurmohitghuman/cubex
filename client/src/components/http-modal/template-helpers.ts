import toast from 'react-hot-toast'
import { httpAPI } from '@/utils/api'
import { HTTPAPIConfig } from './types'

// Blank/default HTTPAPIConfig used when the modal opens fresh or resets.
// Lives here so HTTPAPIColumnModal stays under the 200-line cap.
export const blankHTTPConfig: HTTPAPIConfig = {
  method: 'GET',
  endpointUrl: '',
  queryParams: [{ key: '', value: '' }],
  headers: [{ key: '', value: '' }],
  body: '',
  responseMapping: [{ jsonPath: '$', columnName: '' }],
  previewSize: 5,
  concurrency: 5,
  retries: 3,
  skipMissingFields: false,
}

// Coerce a saved-template's possibly-stringified config back into the modal's
// HTTPAPIConfig shape. Older templates stored config as a JSON string; newer
// ones store as an object. Both paths supported.
export function templateToConfig(template: { config: any }): HTTPAPIConfig {
  const tc = typeof template.config === 'string' ? JSON.parse(template.config) : template.config
  return {
    method: tc.method || 'GET',
    endpointUrl: tc.endpointUrl || '',
    queryParams: tc.queryParams?.length ? tc.queryParams : [{ key: '', value: '' }],
    headers: tc.headers?.length ? tc.headers : [{ key: '', value: '' }],
    body: tc.body || '',
    responseMapping: tc.responseMapping?.length ? tc.responseMapping : [{ jsonPath: '$', columnName: '' }],
    previewSize: tc.previewSize || 5,
    concurrency: tc.concurrency || 5,
    rateLimit: tc.rateLimit,
    retries: tc.retries || 3,
    skipMissingFields: tc.skipMissingFields || false,
  }
}

// Wrapper around httpAPI.createTemplate that toasts on success/failure.
// Keeps the call site inside HTTPAPIColumnModal a one-liner.
export async function saveAsTemplate(
  config: HTTPAPIConfig,
  name: string,
  description?: string,
  tags?: string,
  isDraft?: boolean,
): Promise<void> {
  try {
    await httpAPI.createTemplate({ name, description, config, tags, is_draft: isDraft || false })
    toast.success('Template saved successfully')
  } catch (error) {
    console.error('Error saving template:', error)
    toast.error('Failed to save template')
  }
}
