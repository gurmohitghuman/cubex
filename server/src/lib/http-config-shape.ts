// Shape coercion + parsing helpers shared between /http/generate-config and
// /http/troubleshoot-config. Both endpoints ask the model for a JSON config
// matching the HTTPAPIConfig shape; both have to defensively coerce the
// response (models add markdown fences, drop fields, mistype types).
//
// Lives in lib/ so each route file stays under the 200-line cap.

export function hostFromUrl(raw: string): string | null {
  try {
    const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(candidate).hostname.replace(/^www\./, '').toLowerCase();
  } catch { return null; }
}

export function safeParseJSON(raw: string): unknown {
  // Some models still wrap JSON in ```json fences despite "no markdown" in the
  // system prompt. Strip them defensively before parsing.
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(stripped); } catch { return null; }
}

// Coerce the model's output into the HTTPAPIConfig shape the modal expects.
// Returns null if the shape is fundamentally wrong (no URL, etc.).
export function toModalConfig(parsed: unknown): any | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, any>;
  if (typeof p.endpointUrl !== 'string' || !p.endpointUrl) return null;
  const method = ['GET', 'POST', 'PUT', 'DELETE'].includes(p.method) ? p.method : 'GET';
  const safeArr = (v: unknown): any[] => Array.isArray(v) ? v : [];
  return {
    method,
    endpointUrl: p.endpointUrl,
    queryParams: safeArr(p.queryParams)
      .filter(x => x && typeof x.key === 'string' && typeof x.value === 'string')
      .map(x => ({ key: x.key, value: x.value })),
    headers: safeArr(p.headers)
      .filter(x => x && typeof x.key === 'string' && typeof x.value === 'string')
      .map(x => ({ key: x.key, value: x.value })),
    body: typeof p.body === 'string' ? p.body : '',
    responseMapping: safeArr(p.responseMapping)
      .filter(x => x && typeof x.jsonPath === 'string' && typeof x.columnName === 'string')
      .map(x => ({ jsonPath: x.jsonPath, columnName: x.columnName })),
    previewSize: 5,
    concurrency: 5,
    retries: 3,
    skipMissingFields: false,
    connectionName: typeof p.connectionName === 'string' ? p.connectionName : undefined,
  };
}
