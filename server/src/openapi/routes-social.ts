// /api/v1 routes: social research tables (api-v1-social.ts, services/social-agent.ts).
import { z } from 'zod';
import { PLATFORMS } from '../lib/social/platforms';
import { STEPS } from '../lib/social/names';
import {
  SOCIAL_MAX_DAYS, SOCIAL_MAX_POSTS_PER_SEARCH, SOCIAL_MAX_SEARCHES, SOCIAL_POSTS_PER_SEARCH,
} from '../lib/social/input';
import { op, type RouteDoc } from './route-doc';

export const socialRoutes = (): RouteDoc[] => [
  op({
    method: 'post', path: '/social-research', operationId: 'createSocialResearch', tag: 'social', scope: 'write',
    summary: 'Make a table of social posts on a topic: Searches, a Posts sheet per platform, and the steps picked.',
    description: 'Nothing is searched or run yet: find-posts searches, and each step (set up, not run) runs on the '
      + 'posts when asked. The filters make a Top posts view on each Posts sheet.',
    body: z.object({
      topic: z.string().describe('What to research. It names the table and is the search unless searches is given.'),
      searches: z.array(z.string()).optional()
        .describe(`The words to search for, one search each. At most ${SOCIAL_MAX_SEARCHES}.`),
      platforms: z.array(z.enum(PLATFORMS)).describe('The platforms to search.'),
      steps: z.array(z.enum(STEPS)).optional()
        .describe('Columns set up on each Posts sheet, not run: transcript, breakdown (AI: hook, tension, payoff, '
          + 'why it works), creator (followers, bio), comments (into a Comments sheet, with an AI reaction tag).'),
      min_views: z.number().int().min(0).optional().describe('Top posts: at least this many views.'),
      min_comments: z.number().int().min(0).optional().describe('Top posts: at least this many comments.'),
      posted_within_days: z.number().int().min(1).max(SOCIAL_MAX_DAYS).optional()
        .describe('Top posts: posted in the last N days, counted from each find-posts.'),
      posts_per_search: z.number().int().min(1).max(SOCIAL_MAX_POSTS_PER_SEARCH).optional()
        .describe(`Posts each search adds at most, per platform. Default ${SOCIAL_POSTS_PER_SEARCH}.`),
    }),
    responses: { 201: 'The new table.' },
  }),
  op({
    method: 'get', path: '/social-research/{id}', operationId: 'getSocialResearch', tag: 'social', scope: 'read',
    summary: 'A social research table: its sheets, steps and filters.',
  }),
  op({
    method: 'post', path: '/social-research/{id}/find-posts', operationId: 'findSocialPosts', tag: 'social',
    scope: 'run', summary: 'Search every row of Searches on each platform, adding only posts never found before.',
    description: 'An estimate unless estimate_only is false; then max_cost_usd (the estimate\'s high_usd) is '
      + 'required, and a search that could now cost more is refused with the new estimate (409).',
    body: z.object({
      estimate_only: z.boolean().optional().describe('false searches for real. Default true: the cost.'),
      max_cost_usd: z.number().positive().optional().describe("With estimate_only false: the estimate's high_usd."),
      time_zone: z.string().optional().describe("The user's IANA time zone, for First seen's day. Default UTC."),
    }),
  }),
];
