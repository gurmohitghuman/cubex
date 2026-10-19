import { CHUNK_RELOAD_WINDOW_MS } from './constants'

// An update replaces the build, hashed file names and all, so a tab opened before
// it asks for a file that's gone the first time it opens a table (the one page
// loaded on demand). Reload once and the page comes back on the new build. A second
// failure inside the window is a real one and reaches the error page instead of
// reloading forever, and so does a failure while offline or without sessionStorage.
const RELOADED_AT_KEY = 'cubex-chunk-reload-at'

export function reloadOnChunkError<T>(load: () => Promise<T>): () => Promise<T> {
  return () => load().catch((error: unknown) => {
    if (!reloadOnce()) throw error
    // Keep the Suspense fallback up until the reload replaces the page.
    return new Promise<T>(() => {})
  })
}

function reloadOnce(): boolean {
  if (!navigator.onLine) return false
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT_KEY)) || 0
    if (Date.now() - last < CHUNK_RELOAD_WINDOW_MS) return false
    sessionStorage.setItem(RELOADED_AT_KEY, String(Date.now()))
  } catch {
    return false
  }
  window.location.reload()
  return true
}
