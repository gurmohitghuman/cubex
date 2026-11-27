// What a social research table is made from, checked (pure): the app sends
// camelCase, /api/v1 and MCP snake_case. A topic names the table and is its
// first search unless searches are given; platforms and steps are only what
// the person picked (nothing is on by default beyond the platforms asked for);
// the filters become the Top posts view.
import { PLATFORMS, type Platform } from './platforms';
import { STEPS, type SocialStep } from './names';

import {
  SOCIAL_MAX_DAYS, SOCIAL_MAX_POSTS_PER_SEARCH, SOCIAL_MAX_SEARCH_CHARS, SOCIAL_MAX_SEARCHES, SOCIAL_POSTS_PER_SEARCH,
} from '../constants';
export {
  SOCIAL_MAX_DAYS, SOCIAL_MAX_POSTS_PER_SEARCH, SOCIAL_MAX_SEARCH_CHARS, SOCIAL_MAX_SEARCHES, SOCIAL_POSTS_PER_SEARCH,
};

export interface SocialInput {
  topic: string;
  searches: string[];
  platforms: Platform[];
  steps: SocialStep[];
  minViews: number | null;
  minComments: number | null;
  postedWithinDays: number | null;
  perSearch: number;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const KEYS = {
  app: ['topic', 'searches', 'platforms', 'steps', 'minViews', 'minComments', 'postedWithinDays', 'perSearch'],
  v1: ['topic', 'searches', 'platforms', 'steps', 'min_views', 'min_comments', 'posted_within_days',
    'posts_per_search'],
};

export function socialInputOf(b: Record<string, unknown>, from: 'app' | 'v1' | 'mcp'):
  { ok: SocialInput } | { error: string } {
  const keys = KEYS[from === 'app' ? 'app' : 'v1'];
  const stray = Object.keys(b).find(k => !keys.includes(k) && b[k] !== undefined);
  if (stray) return { error: `Unknown field ${stray}.` };
  const field = (camel: string, snake: string) => (from === 'app' ? b[camel] : b[snake]);

  if (typeof b.topic !== 'string' || !clean(b.topic)) return { error: 'topic is required: what to research.' };
  const topic = clean(b.topic);
  if (topic.length > SOCIAL_MAX_SEARCH_CHARS) {
    return { error: `topic is at most ${SOCIAL_MAX_SEARCH_CHARS} characters.` };
  }
  const raw = b.searches ?? [topic];
  if (!Array.isArray(raw) || raw.some(s => typeof s !== 'string')) return { error: 'searches is a list of words.' };
  const searches = [...new Set((raw as string[]).map(clean).filter(Boolean))];
  if (searches.length === 0 || searches.length > SOCIAL_MAX_SEARCHES) {
    return { error: `searches lists 1 to ${SOCIAL_MAX_SEARCHES} searches.` };
  }
  const long = searches.find(s => s.length > SOCIAL_MAX_SEARCH_CHARS);
  if (long) return { error: `A search is at most ${SOCIAL_MAX_SEARCH_CHARS} characters: "${long.slice(0, 40)}…".` };

  const platforms = b.platforms;
  if (!Array.isArray(platforms) || platforms.length === 0
    || platforms.some(p => !(PLATFORMS as readonly unknown[]).includes(p))) {
    return { error: `platforms lists one or more of ${PLATFORMS.join(', ')}.` };
  }
  const steps = b.steps ?? [];
  if (!Array.isArray(steps) || steps.some(s => !(STEPS as readonly unknown[]).includes(s))) {
    return { error: `steps lists any of ${STEPS.join(', ')} (none: only the posts).` };
  }

  const count = (camel: string, snake: string, max: number, min = 0): { value: number | null } | { error: string } => {
    const v = field(camel, snake);
    if (v === undefined || v === null) return { value: null };
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) {
      return { error: `${from === 'app' ? camel : snake} must be a whole number from ${min} to ${max.toLocaleString(
        'en-US')}.` };
    }
    return { value: v };
  };
  const minViews = count('minViews', 'min_views', 1e12);
  if ('error' in minViews) return minViews;
  const minComments = count('minComments', 'min_comments', 1e9);
  if ('error' in minComments) return minComments;
  const days = count('postedWithinDays', 'posted_within_days', SOCIAL_MAX_DAYS, 1);
  if ('error' in days) return days;
  const per = count('perSearch', 'posts_per_search', SOCIAL_MAX_POSTS_PER_SEARCH, 1);
  if ('error' in per) return per;
  return {
    ok: {
      topic, searches, platforms: [...new Set(platforms as Platform[])], steps: [...new Set(steps as SocialStep[])],
      minViews: minViews.value, minComments: minComments.value, postedWithinDays: days.value,
      perSearch: per.value ?? SOCIAL_POSTS_PER_SEARCH,
    },
  };
}
