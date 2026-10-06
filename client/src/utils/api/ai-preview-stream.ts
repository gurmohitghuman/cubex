import { redirectToLoginOn401 } from './client'
import type { AIPreview } from './types'
import type { SearchPlanSummary } from './types-search'

// Params accepted by the streaming preview endpoint (a subset of AIRunParams —
// only the fields /ai/preview reads). Kept local so this module doesn't depend on
// the run-shaped type in ai-http.ts.
export interface PreviewStreamParams {
  sheetId: string
  columnName: string
  prompt: string
  systemPrompt?: string
  model?: string
  temperature?: number
  useOpenRouterWebSearch?: boolean
  useWebFetch?: boolean
  maxChars?: number
  previewSize?: number
  searchEngine?: string
  searchMode?: string
  maxSearchesPerRow?: number
}

// Streaming preview. The server responds with NDJSON (one JSON object per line):
// {type:'row', ...AIPreview} as each row's OpenRouter call returns, then a final
// {type:'done', totalRows}. onRow fires per row so the UI renders results as they
// land instead of after the slowest of the batch. Uses fetch (not axios) because
// axios doesn't expose the browser ReadableStream; the HttpOnly session cookie is
// sent via credentials:'include'. Resolves with totalRows once the stream closes.
// `signal` lets the caller abort (modal close / new preview) — that closes the
// socket, which the server detects (req 'close') to stop calling OpenRouter.
// No progress for this long → treat the stream as hung and abort. This is a STALL
// timeout (reset on every chunk), not an overall cap: a large preview with slow
// reasoning models can legitimately run minutes total, but no single gap between
// bytes should exceed this. Sized above the server's worst-case per-row time so it
// never fires on a slow-but-alive row: a row is bounded by the 60s per-row timeout,
// and a 429 retry adds ~2s + up to another 60s (~122s). 150s leaves headroom over
// that tail while still killing a genuinely dead stream promptly.
const STREAM_STALL_MS = 150_000

export const previewStream = async (
  params: PreviewStreamParams,
  onRow: (row: AIPreview) => void,
  signal?: AbortSignal,
): Promise<{ totalRows: number; runTargetRows: number; webSearch: SearchPlanSummary | null }> => {
  // Internal controller aborts on EITHER the caller's signal (modal close / supersede)
  // OR a stall. fetch + the reader both observe it, so a hung stream can't strand the
  // caller's isGeneratingPreview forever.
  const ctrl = new AbortController()
  const onCallerAbort = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onCallerAbort, { once: true })
  }
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => ctrl.abort(), STREAM_STALL_MS)
  }
  // Single cleanup for the controller wiring + stall timer. Runs on EVERY exit path
  // (fetch error, non-ok response, stream error, normal completion) so neither the
  // caller-abort listener nor the timer leaks.
  const cleanup = () => {
    if (stallTimer) clearTimeout(stallTimer)
    if (signal) signal.removeEventListener('abort', onCallerAbort)
  }

  // Arm the stall BEFORE fetch so a server that never sends headers also times out
  // (the read loop alone wouldn't cover the initial connect).
  armStall()
  let res: Response
  try {
    res = await fetch('/api/ai/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(params),
      signal: ctrl.signal,
    })
  } catch (e: any) {
    cleanup()
    // Normalize an abort (caller or stall) into a clear error for the caller's catch.
    if (e?.name === 'AbortError') throw new Error(signal?.aborted ? 'aborted' : 'Preview timed out')
    throw e
  }
  if (!res.ok || !res.body) {
    cleanup()
    // 401 → mirror the axios interceptor (which fetch bypasses) so an expired
    // session redirects to /login instead of just toasting and stranding the user.
    if (res.status === 401) { redirectToLoginOn401(); throw new Error('Session expired') }
    // Non-stream error response is JSON ({error}). Surface it the same shape the
    // caller's catch expects from axios.
    let msg = 'Failed to generate preview'
    try { msg = (await res.json())?.error || msg } catch { /* non-JSON body */ }
    throw new Error(msg)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // null until the server's {type:'done'} line arrives. A clean EOF that NEVER sent
  // done (proxy truncation, server crash mid-stream, Cloudflare cutting the socket)
  // must NOT be treated as success — otherwise the caller commits a partial set.
  let totalRows: number | null = null
  // The UNFILTERED count of rows "Run All Rows" will process (for the cost estimate).
  let runTargetRows = 0
  // With web search: the engine the run's searches go to, priced.
  let webSearch: SearchPlanSummary | null = null
  // Parse one NDJSON line. Bad JSON (a proxy-truncated chunk, a corrupt line)
  // throws a clean error instead of a raw SyntaxError.
  const handleLine = (line: string) => {
    let msg: { type: 'row' } & AIPreview
      | { type: 'done'; totalRows: number; runTargetRows?: number; webSearch?: SearchPlanSummary | null }
      | { type: 'error'; error: string }
    try {
      msg = JSON.parse(line)
    } catch {
      throw new Error('Malformed preview stream')
    }
    if (msg.type === 'row') {
      const { type: _t, ...row } = msg
      onRow(row)
    } else if (msg.type === 'done') {
      totalRows = msg.totalRows
      runTargetRows = msg.runTargetRows ?? 0
      webSearch = msg.webSearch ?? null
    } else if (msg.type === 'error') {
      throw new Error(msg.error)
    }
  }
  try {
    armStall()
    // Read the stream, splitting on newlines. A chunk can end mid-line, so keep
    // the trailing partial in `buffer` until the next newline arrives.
    for (;;) {
      let chunk
      try {
        chunk = await reader.read()
      } catch (e: any) {
        // The abort (stall or caller) surfaces here as the reader rejects.
        if (e?.name === 'AbortError') throw new Error(signal?.aborted ? 'aborted' : 'Preview timed out')
        throw e
      }
      if (chunk.done) break
      armStall() // progress — reset the stall clock
      buffer += decoder.decode(chunk.value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) handleLine(line)
      }
    }
    // Flush any multi-byte remainder the streaming decode held back, then parse a
    // final line that arrived without a trailing newline (e.g. the {type:'done'}).
    buffer += decoder.decode()
    const tail = buffer.trim()
    if (tail) handleLine(tail)
  } finally {
    cleanup()
    // Always release the lock so the body can be GC'd; cancel drops any unread
    // bytes (and, with the AbortController, signals the server to stop).
    try { await reader.cancel() } catch { /* already closed */ }
    reader.releaseLock()
  }
  // The stream ended cleanly but never sent {type:'done'} → it was truncated. Fail
  // rather than silently returning a partial set the caller might commit.
  if (totalRows === null) throw new Error('Preview stream ended before completion')
  return { totalRows, runTargetRows, webSearch }
}
