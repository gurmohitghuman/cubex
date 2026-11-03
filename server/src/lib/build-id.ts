// The app build this server serves: the name of the entry script its client's
// index.html loads ("index-<hash>"), content-hashed by the build, so it changes
// when the app's code does (a server-only update leaves open tabs alone). Sent
// on every /api answer (BUILD_HEADER): a tab compares it with the entry script
// its own page loaded and, when they differ, says Cubex was updated
// (client/src/lib/build-watch.ts). index.html is read again when it changes on
// disk, so a build made before a restart is named from the moment it's served.
// Null when no client is served (in development Vite serves it): no header.
import fs from 'node:fs';
import { BUILD_ID_RECHECK_MS } from './constants';

export const BUILD_HEADER = 'X-Cubex-Build';

const ENTRY = /<script\b[^>]*\bsrc="\/assets\/(index-[A-Za-z0-9_-]+)\.js"/;

let indexPath: string | null = null;
let seen: { mtimeMs: number; id: string | null } | null = null;
let checkedAt = 0;

// Pure: the entry script's name in an index.html, or null.
export function entryOf(html: string): string | null {
  return ENTRY.exec(html)?.[1] ?? null;
}

export function serveBuildFrom(path: string): void {
  indexPath = path;
  seen = null;
  checkedAt = 0;
}

export function currentBuildId(now = Date.now()): string | null {
  if (!indexPath) return null;
  if (seen && now - checkedAt < BUILD_ID_RECHECK_MS) return seen.id;
  checkedAt = now;
  try {
    const { mtimeMs } = fs.statSync(indexPath);
    if (!seen || seen.mtimeMs !== mtimeMs) seen = { mtimeMs, id: entryOf(fs.readFileSync(indexPath, 'utf8')) };
  } catch {
    seen = { mtimeMs: -1, id: null };
  }
  return seen.id;
}
