// The release check: asks GitHub's releases API for Cubex's latest release at most once a day and
// keeps the answer (lib/release-store.ts), so Settings, GET /v1/version and get_version can say
// whether a newer release is out. Nothing else is sent: one GET with a fixed User-Agent, no cookies,
// nothing about this install. The first automatic look comes a minute after the server starts, and a
// timer looks again every hour whether a day has passed, so neither a start nor a page waits on it.
// A check that fails (offline, rate limited, an answer that isn't a release) keeps the last good
// answer and shows no error. Settings → Account → Version turns it off ("Check now" asks at once,
// unless a check went out in the last minute).
import {
  RELEASE_CHECK_EVERY_MS, RELEASE_CHECK_FIRST_MS, RELEASE_CHECK_MAX_BYTES, RELEASE_CHECK_NOW_MIN_MS,
  RELEASE_CHECK_SWEEP_MS, RELEASE_CHECK_TIMEOUT_MS, RELEASE_CHECK_URL,
} from '../lib/constants';
import { parseTag, tagOf } from '../lib/cubex-version';
import { readBoundedBody } from '../lib/http-body-read';
import { dueForReleaseCheck, keepReleaseAnswer, readReleaseState, type LatestRelease } from '../lib/release-store';

export type Found = Omit<LatestRelease, 'checked_at'>;

// Pure: the release a GitHub answer names, or null when it isn't one (no tag, a tag that isn't
// vX.Y.Z, a draft or a pre-release).
export function releaseFrom(body: unknown): Found | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { tag_name?: unknown; published_at?: unknown; draft?: unknown; prerelease?: unknown };
  if (typeof b.tag_name !== 'string' || b.draft === true || b.prerelease === true) return null;
  const tag = parseTag(b.tag_name);
  if (!tag) return null;
  const at = typeof b.published_at === 'string' ? new Date(b.published_at) : null;
  return { version: tagOf(tag), published_at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null };
}

// One GET to `url`. Null for anything but a 200 that names a release: no network, a timeout, a rate
// limit (403 or 429), an answer too large or not JSON.
export async function fetchLatestRelease(url = RELEASE_CHECK_URL): Promise<Found | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Cubex' },
      signal: AbortSignal.timeout(RELEASE_CHECK_TIMEOUT_MS),
    });
    if (res.status !== 200 || !res.body) { await res.body?.cancel().catch(() => {}); return null; }
    const text = await readBoundedBody(res.body as unknown as AsyncIterable<unknown>, RELEASE_CHECK_MAX_BYTES);
    return releaseFrom(JSON.parse(text));
  } catch {
    return null;
  }
}

// One request at a time: a "Check now" while the automatic check is out shares its answer.
let out: Promise<Found | null> | null = null;
function askOnce(): Promise<Found | null> {
  out ??= fetchLatestRelease().finally(() => { out = null; });
  return out;
}

async function checkFor(userIds: string[]): Promise<Found | null> {
  const triedAt = new Date().toISOString();
  const found = await askOnce();
  // Stamped with the time this check went out, so a later check that fails is never mistaken for it.
  const latest = found ? { ...found, checked_at: triedAt } : null;
  for (const userId of userIds) keepReleaseAnswer(userId, latest, triedAt);
  return found;
}

// "Check now" in Settings: asks at once, unless a check (this or the automatic one) went out less than
// RELEASE_CHECK_NOW_MIN_MS ago: then it answers from what that check kept, without asking (asked false).
// reached: GitHub answered this check, or the last one when it didn't ask (the kept answer is that check's).
export async function checkReleaseNow(userId: string, now = Date.now()): Promise<{ reached: boolean; asked: boolean }> {
  const { triedAt, latest } = readReleaseState(userId);
  const since = triedAt ? now - Date.parse(triedAt) : NaN;
  if (since >= 0 && since < RELEASE_CHECK_NOW_MIN_MS) {
    return { reached: latest?.checked_at === triedAt, asked: false };
  }
  return { reached: (await checkFor([userId])) !== null, asked: true };
}

// The automatic check, for every account due one (Cubex has one): a single request serves them all.
export async function checkDueReleases(now = Date.now()): Promise<void> {
  const due = dueForReleaseCheck(new Date(now - RELEASE_CHECK_EVERY_MS).toISOString());
  if (due.length) await checkFor(due);
}

let timer: ReturnType<typeof setInterval> | null = null;

function look(): void {
  checkDueReleases().catch(error => console.error('The release check failed (tried again later):', error));
}

export function startReleaseCheckLoop(): void {
  if (timer) return;
  timer = setInterval(look, RELEASE_CHECK_SWEEP_MS);
  timer.unref?.();
  setTimeout(look, RELEASE_CHECK_FIRST_MS).unref?.();
}
