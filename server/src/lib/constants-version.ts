// The running version and the release check (lib/cubex-version.ts, services/release-check.ts, migration 058).
// Re-exported from constants.ts.

// Cubex's own repository: where releases are published and their notes live.
export const CUBEX_RELEASES_PAGE = 'https://github.com/gurmohitghuman/cubex/releases';
// Where the release check asks for the latest release: GitHub's releases API. An operator setting
// (the e2e harness points it at a local receiver), never user input.
export const RELEASE_CHECK_URL = process.env.RELEASE_CHECK_URL
  || 'https://api.github.com/repos/gurmohitghuman/cubex/releases/latest';
// At most one automatic check in this long, across restarts (release_tried_at).
export const RELEASE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
// The first automatic look after a start, so a start never waits on it; then a look this often to see
// whether a day has passed.
export const RELEASE_CHECK_FIRST_MS = 60 * 1000;
export const RELEASE_CHECK_SWEEP_MS = 60 * 60 * 1000;
// One check gives up after this long, and reads at most this much of the answer.
export const RELEASE_CHECK_TIMEOUT_MS = 10_000;
export const RELEASE_CHECK_MAX_BYTES = 512 * 1024;
