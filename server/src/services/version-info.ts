// What Settings → Account → Version, GET /v1/version and get_version answer: the running version
// (lib/cubex-version.ts), the latest release the check last found (services/release-check.ts) and
// whether it is newer. update_available is null when that can't be told: the running build isn't a
// release (a branch, a local source, or a Docker build that doesn't record it), or no answer is kept.
// pinned_ref: an install made with --ref <tag> stays on it, so `cubex update` won't bring a newer release.
import { CUBEX_RELEASES_PAGE } from '../lib/constants';
import { compareVersions, parseTag, runningVersion } from '../lib/cubex-version';
import { readReleaseState } from '../lib/release-store';

export interface VersionInfo {
  version: string | null;
  build: string | null;
  pinned_ref: string | null;
  update_check: boolean;
  latest_release: { version: string; published_at: string | null; notes_url: string; checked_at: string } | null;
  update_available: boolean | null;
}

// The notes link is built from the tag, never taken from GitHub's answer.
export const notesUrl = (version: string) => `${CUBEX_RELEASES_PAGE}/tag/${encodeURIComponent(version)}`;

export function versionInfo(userId: string): VersionInfo {
  const running = runningVersion();
  const state = readReleaseState(userId);
  const latest = state.updateCheck ? state.latest : null;
  const a = latest ? parseTag(latest.version) : null;
  const b = running.version ? parseTag(running.version) : null;
  return {
    version: running.version,
    build: running.build,
    pinned_ref: running.pinned,
    update_check: state.updateCheck,
    latest_release: latest ? { ...latest, notes_url: notesUrl(latest.version) } : null,
    update_available: a && b ? compareVersions(a, b) > 0 : null,
  };
}
