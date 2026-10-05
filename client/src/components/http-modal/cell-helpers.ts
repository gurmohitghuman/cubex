import { HTTPAPIConfig } from './types'

// Coerce any JSON value to a cell-safe string. The cell-write API rejects
// non-strings with "value must be a string"; numbers (IDs), booleans, arrays,
// objects (when the user picks a whole branch like `workspace`) all need to
// land as readable text. null/undefined become empty cells.
export function cellValueToString(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try { return JSON.stringify(v) } catch { return String(v) }
}

// Derive a friendly master-column name from the endpoint URL's hostname when
// the caller didn't provide one. Used by AI Generate / kid-friendly Manual
// mode so the user doesn't have to type it. The server's own unique-name
// index appends "(2)" / "(3)" on collision.
export function derivedMasterName(masterColumnName: string, endpointUrl: string): string {
  if (masterColumnName.trim()) return masterColumnName.trim()
  try {
    const raw = endpointUrl.trim()
    const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    const host = new URL(candidate).hostname.replace(/^www\./, '').toLowerCase()
    // "api.apollo.io" → "Apollo"; "openai.com" → "Openai"; fallback "API call"
    const main = host.split('.').filter(p => p && p !== 'api' && p !== 'app')[0]
    return main ? main.charAt(0).toUpperCase() + main.slice(1) : 'API call'
  } catch { return 'API call' }
}

// Re-export for callers that want both helpers + the type from one import.
export type { HTTPAPIConfig }

// Walk a simple JSONPath against a JS value. Only supports the subset the
// click-tree generates: `$` root, `.key` for object members, `[n]` for array
// indices. No wildcards, filters, slices, or recursive descent. Returns
// undefined for any segment that doesn't resolve. Used by the commit path
// so the user's tree-clicked fields can be re-extracted from the row's
// rawResponse without a second server round-trip — server's stored
// extractedFields was computed before the user clicked any leaves.
export function extractByJsonPath(raw: unknown, path: string): unknown {
  if (raw === null || raw === undefined) return undefined
  if (typeof path !== 'string' || path.length === 0) return raw
  // Tokenize: split into ['key', '0', 'nested', ...] preserving array indices.
  // The tree always emits paths like `$.foo.bar[0].baz` so this regex is enough.
  const trimmed = path.startsWith('$') ? path.slice(1) : path
  const tokens: string[] = []
  const re = /\.([^.\[\]]+)|\[(\d+)\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(trimmed)) !== null) tokens.push(m[1] ?? m[2])
  let cursor: any = raw
  for (const t of tokens) {
    if (cursor === null || cursor === undefined) return undefined
    cursor = cursor[t]
  }
  return cursor
}
