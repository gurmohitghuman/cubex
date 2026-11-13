// The version this server runs, and how release versions compare. The installer writes the build it
// made to <app>/.cubex-version (install.sh and install.ps1, build_app), and `cubex version` and
// `cubex update` read the same file: "v0.8.12 6071123" for a release, "main 6071123" for a branch,
// "local 6071123 2026-11-13 10:00" for a local source. A Docker or Coolify build has none: its
// version isn't recorded. Read once, at first use: an update swaps the app folder only while Cubex
// is stopped. CUBEX_TEST_VERSION_FILE (set only by scripts/e2e-harness.mjs, never in production)
// names another file, read at every use, so a spec can set the running version.
import fs from 'node:fs';
import path from 'node:path';

const TEST_FILE = process.env.CUBEX_TEST_VERSION_FILE || '';
// From server/src/lib (tsx) or server/dist/lib (a build) up to the app folder.
const FILE = TEST_FILE || path.resolve(__dirname, '../../../.cubex-version');
const BUILD_MAX = 120;
const TAG = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;

export interface Semver { major: number; minor: number; patch: number }
export interface Running {
  build: string | null;    // the file's line, as written; null when not recorded
  version: string | null;  // its release ("v0.8.12"); null for a branch, a local source or no file
}

// Pure: a release tag ("v0.8.12" or "0.8.12") as numbers, or null (a branch, a pre-release, junk).
export function parseTag(tag: string): Semver | null {
  const m = TAG.exec(tag.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

export function tagOf(v: Semver): string {
  return `v${v.major}.${v.minor}.${v.patch}`;
}

// Pure: below zero, zero or above zero as a is older than, the same as or newer than b. By number,
// part by part, so v0.8.10 is newer than v0.8.9.
export function compareVersions(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

// Pure: what a .cubex-version file says. Its first line, control characters dropped and capped; the
// release is its first word when that is a release tag.
export function runningFrom(text: string | null): Running {
  const build = (text ?? '').split(/\r?\n/)[0].replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, BUILD_MAX);
  if (!build) return { build: null, version: null };
  const tag = parseTag(build.split(/\s+/)[0]);
  return { build, version: tag ? tagOf(tag) : null };
}

let cached: Running | null = null;

export function runningVersion(): Running {
  if (cached && !TEST_FILE) return cached;
  let text: string | null = null;
  try { text = fs.readFileSync(FILE, 'utf8'); } catch { text = null; }
  cached = runningFrom(text);
  return cached;
}
