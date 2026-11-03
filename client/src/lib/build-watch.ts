// Was Cubex updated while this tab stayed open? Every API answer names the app
// build the server serves (X-Cubex-Build: its entry script, "index-<hash>";
// server/src/lib/build-id.ts). This tab's build is the entry script its own
// page loaded, still in the page. When the two differ, the server serves a
// newer app than the one running here. Said once.
export const BUILD_HEADER = 'x-cubex-build'

const ENTRY = /\/assets\/(index-[A-Za-z0-9_-]+)\.js$/

// Pure: the build an entry script URL names, or null (in development the page
// loads /src/main.tsx: no build, no notice).
export function buildOfScript(src: string | null | undefined): string | null {
  if (!src) return null
  try {
    return ENTRY.exec(new URL(src, 'http://x').pathname)?.[1] ?? null
  } catch {
    return null
  }
}

let ours: string | null | undefined

export function tabBuild(): string | null {
  if (ours === undefined) {
    const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')
    ours = buildOfScript(script?.getAttribute('src'))
  }
  return ours
}

let told = false

export function updatedSinceLoad(server: unknown, own: string | null): boolean {
  if (told || !own || typeof server !== 'string' || server === '' || server === own) return false
  told = true
  return true
}

// Tests only: as if nothing was said yet.
export function resetBuildWatch(): void {
  told = false
}
