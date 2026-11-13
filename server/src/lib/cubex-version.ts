// The version this server runs, and how release versions compare. The installer writes the build it
// made to <app>/.cubex-version (install.sh and install.ps1, build_app), and `cubex version` and
// `cubex update` read the same file: "v0.8.12 6071123" for a release, "main 6071123" for a branch,
// "local 6071123 2026-11-13 10:00" for a local source. A Docker or Coolify build has none: its
// version isn't recorded. The installer also writes <install folder>/install.env beside the app; its
// CUBEX_REF is what `cubex update` installs, so an install made with --ref <tag> stays on that tag.
// .cubex-version is read once, at first use: an update swaps the app folder only while Cubex is
// stopped. install.env is read at every use: the install command run again with --ref on an install
// already on that version rewrites it without a restart. CUBEX_TEST_HOME (set only by
// scripts/e2e-harness.mjs and unit tests, never in production) names a folder laid out like an install
// (app/.cubex-version, install.env), whose .cubex-version is read at every use too.
import fs from 'node:fs';
import path from 'node:path';

const TEST_HOME = process.env.CUBEX_TEST_HOME || '';
// From server/src/lib (tsx) or server/dist/lib (a build) up to the app folder.
const APP = TEST_HOME ? path.join(TEST_HOME, 'app') : path.resolve(__dirname, '../../..');
const HOME = path.dirname(APP);
const TEXT_MAX = 120;
const TAG = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;

export interface Semver { major: number; minor: number; patch: number }
export interface Running {
  build: string | null;    // the file's line, as written; null when not recorded
  version: string | null;  // its release ("v0.8.12"); null for a branch, a local source or no file
  pinned: string | null;   // the ref an install made with --ref stays on; null when it follows releases
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

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, TEXT_MAX);

// Pure: what a .cubex-version file says. Its first line, control characters dropped and capped; the
// release is its first word when that is a release tag.
export function runningFrom(text: string | null): Omit<Running, 'pinned'> {
  const build = clean((text ?? '').split(/\r?\n/)[0]);
  if (!build) return { build: null, version: null };
  const tag = parseTag(build.split(/\s+/)[0]);
  return { build, version: tag ? tagOf(tag) : null };
}

// Pure: the ref an install.env pins, or null. install.sh writes CUBEX_REF=<ref> shell-quoted (printf
// %q), install.ps1 plainly; "stable" (or nothing) follows the latest release.
export function pinnedFrom(text: string | null): string | null {
  const m = /^CUBEX_REF=(.*)$/m.exec(text ?? '');
  if (!m) return null;
  let ref = m[1].replace(/\r$/, '').trim();
  if (ref.length >= 2 && ref.startsWith("'") && ref.endsWith("'")) ref = ref.slice(1, -1);
  ref = clean(ref.replace(/\\(.)/g, '$1'));
  return ref && ref !== 'stable' ? ref : null;
}

const read = (file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
let cached: { build: Omit<Running, 'pinned'>; installed: boolean } | null = null;

// The running build, without the pin (MCP's serverInfo, on every request).
export function runningBuild(): Omit<Running, 'pinned'> {
  return builtApp().build;
}

// install.env is read only from a folder the installer marked as an install (.cubex-home) and only
// when the app has a .cubex-version, so a source checkout never reads a file beside it.
export function runningVersion(): Running {
  const app = builtApp();
  return { ...app.build, pinned: app.installed ? pinnedFrom(read(path.join(HOME, 'install.env'))) : null };
}

function builtApp(): { build: Omit<Running, 'pinned'>; installed: boolean } {
  if (cached && !TEST_HOME) return cached;
  const text = read(path.join(APP, '.cubex-version'));
  cached = { build: runningFrom(text), installed: text !== null && fs.existsSync(path.join(HOME, '.cubex-home')) };
  return cached;
}
