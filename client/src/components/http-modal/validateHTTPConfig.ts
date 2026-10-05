import { HTTPAPIConfig } from './types'

// Normalize a user-typed endpoint the way submission does (bare host → https://)
// and return its parsed URL, or null if it's unparseable OR not http(s). The
// scheme gate is the important part: `new URL()` happily accepts javascript:,
// file:, data:, etc. The server SSRF guard is the real defense, but rejecting
// non-http(s) here gives the user an immediate, clear error instead of a confusing
// server-side failure — and closes the client-only validation bypass.
export const normalizeHttpUrl = (raw: string): URL | null => {
  try {
    const u = new URL(raw.includes('/') && !raw.startsWith('http') ? `https://${raw}` : raw)
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u : null
  } catch {
    return null
  }
}

// Pure validation for the HTTP-enrichment config. Extracted from useHTTPRunHandlers
// so the hook stays focused on run lifecycle + preview-commit. Writes errors via the
// passed setter and returns whether the config is valid.
//
// `forPreview = true` skips the response-mapping check: the kid-friendly flow lets
// users hit "Try on 1 row" before declaring any fields, then pick fields by clicking
// the JSON tree on the next screen. The check is re-applied at run-start time
// (handleStartRun) where mappings are required.
export const validateHTTPConfig = (
  config: HTTPAPIConfig,
  setErrors: (e: Record<string, string>) => void,
  forPreview = false,
): boolean => {
  const errs: Record<string, string> = {}
  // Master column name is auto-derived if blank — never block the user on this.
  if (!config.endpointUrl.trim()) errs.endpointUrl = 'Endpoint URL is required'

  if (config.endpointUrl.trim() && normalizeHttpUrl(config.endpointUrl) === null) {
    errs.endpointUrl = 'Enter a valid http(s):// URL'
  }

  const mapping = config.responseMapping ?? []
  if (!forPreview) {
    const mappingErrors: string[] = []
    mapping.forEach((m, i) => {
      if (!m.jsonPath?.trim()) mappingErrors.push(`Row ${i + 1}: JSONPath is required`)
      if (!m.columnName?.trim()) mappingErrors.push(`Row ${i + 1}: Column name is required`)
    })
    if (mappingErrors.length > 0) errs.responseMapping = mappingErrors.join(', ')
  }

  const names = mapping.map(m => (m.columnName ?? '').trim()).filter(Boolean)
  const dups = names.filter((n, i) => names.indexOf(n) !== i)
  if (dups.length > 0) errs.duplicateColumns = `Duplicate column names: ${dups.join(', ')}`

  if (config.body && ['POST', 'PUT', 'DELETE'].includes(config.method)) {
    try { JSON.parse(config.body) } catch { errs.body = 'Body must be valid JSON' }
  }

  setErrors(errs)
  return Object.keys(errs).length === 0
}
