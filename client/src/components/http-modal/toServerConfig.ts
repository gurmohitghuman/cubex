import { HTTPAPIConfig } from './types'
import { HTTP_RETRY_DEFAULT } from '@/lib/constants'

// Convert the modal's flat config shape into the {requestConfig, responseMapping} shape
// the server expects. The two diverged historically — the client uses endpointUrl /
// headers: Array<{key,value}> / queryParams: Array<{key,value}>, while the server reads
// requestConfig.url / requestConfig.headers: Record<string,string> with query params
// appended into the URL. Without this adapter the server silently 400s every
// preview/run.
export function toServerConfig(c: HTTPAPIConfig) {
  const arrayToRecord = (pairs: Array<{ key: string; value: string }>) =>
    pairs.reduce<Record<string, string>>((acc, p) => {
      // Skip entries with bad shapes — AI Generate / templates can produce
      // {key: 'Header', value: undefined} or {key: '', value: '...'}. Either
      // would crash the server's template substitution downstream.
      if (!p || typeof p.key !== 'string' || typeof p.value !== 'string') return acc
      const k = p.key.trim()
      if (k) acc[k] = p.value
      return acc
    }, {})

  // Append query params to the URL. We DON'T URL-encode the values because they may
  // contain template tokens like {{column}} that need to survive intact for server-side
  // substitution. The user is responsible for encoding within the value if needed.
  //
  // Defensive `?? []` on every array field: configs from external sources
  // (AI Generate response, saved templates, partial setConfig calls) can
  // arrive missing fields. Without these guards, a single bad shape throws
  // "Cannot read properties of undefined (reading 'filter')" client-side.
  let url = c.endpointUrl
  const queryParams = c.queryParams ?? []
  const qpEntries = queryParams.filter(p => p.key.trim())
  if (qpEntries.length > 0) {
    const qs = qpEntries.map(p => `${p.key.trim()}=${p.value}`).join('&')
    url += (url.includes('?') ? '&' : '?') + qs
  }

  return {
    requestConfig: {
      method: c.method,
      url,
      headers: arrayToRecord(c.headers ?? []),
      body: c.body && c.body.trim() ? c.body : undefined,
      ...(c.skipEmpty ? { skipEmpty: true } : {}),
      ...(c.timeoutMs ? { timeout: c.timeoutMs } : {}),
      ...(c.goneColumns?.length ? { goneColumns: c.goneColumns } : {}),
    },
    responseMapping: c.responseMapping ?? [],
    previewSize: c.previewSize,
    concurrency: c.concurrency,
    batchSize: c.concurrency, // server reads batchSize on http_runs.config
    retries: c.retries,
    ...(c.retryPost ? { retryPost: true } : {}),
    ...(c.runIf?.trim() ? { runIf: c.runIf } : {}),
  }
}

// Back the other way: a column's stored setup into the dialog (its Edit). The query string stays in the URL,
// headers become rows, and what the dialog has no field for (the timeout, the deleted columns it read) is kept.
export function fromServerConfig(s: any): HTTPAPIConfig {
  const rc = s?.requestConfig ?? {}
  const headers = Object.entries((rc.headers ?? {}) as Record<string, string>).map(([key, value]) => ({ key, value }))
  const mapping = Array.isArray(s?.responseMapping) ? s.responseMapping as HTTPAPIConfig['responseMapping'] : []
  const batch = typeof s?.batchSize === 'number' ? s.batchSize : typeof s?.concurrency === 'number' ? s.concurrency : 5
  const gone = (Array.isArray(rc.goneColumns) ? rc.goneColumns as unknown[] : [])
    .filter((c): c is string => typeof c === 'string')
  return {
    method: rc.method ?? 'GET', endpointUrl: rc.url ?? '', queryParams: [{ key: '', value: '' }],
    headers: headers.length ? headers : [{ key: '', value: '' }], body: rc.body ?? '',
    responseMapping: mapping.length ? mapping.map(m => ({ jsonPath: m.jsonPath, columnName: m.columnName }))
      : [{ jsonPath: '$', columnName: '' }],
    previewSize: typeof s?.previewSize === 'number' ? s.previewSize : 5, concurrency: batch,
    retries: typeof s?.retries === 'number' ? s.retries : HTTP_RETRY_DEFAULT, retryPost: s?.retryPost === true,
    skipEmpty: rc.skipEmpty === true, ...(s?.runIf ? { runIf: s.runIf } : {}),
    ...(typeof rc.timeout === 'number' ? { timeoutMs: rc.timeout } : {}),
    ...(gone.length ? { goneColumns: gone } : {}),
  }
}
