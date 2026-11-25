// Each platform a social research table can search (pure): the search that
// adds its posts (pinned to one provider: a routed search answers in the shape
// of whichever provider served it, and a Posts sheet maps one shape), the
// fields it keeps, how its Posted day is worked out, and the tools its steps
// use. Checked against treg's live catalog at create (services/social-create.ts):
// a platform whose search Cubex can't add rows from isn't offered.
// Shapes and prices from paid checks on 2026-11-24 (TODO.md, Social research tables).
import { POST_COLUMNS as P, STEP_COLUMNS as S } from './names';

export const PLATFORMS = ['tiktok', 'instagram', 'youtube', 'x'] as const;
export type Platform = typeof PLATFORMS[number];

export interface ListSpec {
  toolId: string;
  provider: string | null;            // a routed tool's one provider; null: a provider's own tool
  inputs: Record<string, string>;     // tool input → the column it reads
  fields: Array<{ path: string; columnName: string }>;
  dedupe: { path: string; also?: string[] };
}
export interface StepTool {
  toolId: string;
  inputs: Record<string, string>;
  // An output the catalog lists (path) or one read from the answer (fromAnswer: a list's first item, say).
  outputs: Array<{ key: string; path: string; columnName: string; fromAnswer?: true }>;
}
export interface PlatformSpec {
  id: Platform; label: string;
  search: ListSpec & { query: string };
  // Columns its search fills beyond the common ones, and the formulas worked out from them.
  formulas: Array<{ column: string; formula: string }>;
  transcript: StepTool;
  creator: StepTool | null;           // null: the search gives the followers already
  comments: ListSpec;
}

const UNIX_DAY = `{{${P.postedAt}}} ? new Date(Number({{${P.postedAt}}}) * 1000).toISOString().slice(0, 10) : ''`;
// YouTube's search says "6 hours ago": the day, counted back from the day it was found.
const RELATIVE_DAY = `(() => { const m = /(\\d+)\\s*(minute|hour|day|week|month|year)/i.exec(String({{${P.postedAt}}}));
  const seen = {{${P.firstSeen}}}; if (!m || !seen) return '';
  const days = { minute: 0, hour: 0, day: 1, week: 7, month: 30, year: 365 }[m[2].toLowerCase()] * Number(m[1]);
  return new Date(Date.parse(seen) - days * 86400000).toISOString().slice(0, 10); })()`;

const field = (path: string, columnName: string) => ({ path, columnName });
// Routed comment tools answer text, author, likes and replies whoever serves them; X's own its replies' names.
const COMMENT_FIELDS = (names = { author: '$.author', likes: '$.likes', replies: '$.replies' }) => [
  field('$.text', 'Comment'), field(names.author, 'Author'), field(names.likes, 'Likes'),
  field(names.replies, 'Replies'),
];

export const PLATFORM_SPECS: Record<Platform, PlatformSpec> = {
  tiktok: {
    id: 'tiktok', label: 'TikTok',
    search: {
      toolId: 'anyapi.tiktok.search.videos', provider: null, query: 'query', inputs: {},
      fields: [field('$.url', P.post), field('$.author', P.author), field('$.caption', P.caption),
        field('$.views', P.views), field('$.likes', P.likes), field('$.comments', P.comments),
        field('$.shares', P.shares), field('$.createdUtc', P.postedAt), field('$.authorFollowers', P.followers)],
      dedupe: { path: '$.url', also: ['$.id'] },
    },
    formulas: [{ column: P.posted, formula: UNIX_DAY }],
    transcript: { toolId: 'anyapi.tiktok.video.captions', inputs: { url: P.post },
      outputs: [{ key: 'output.data.transcript', path: '$.output.data.transcript', columnName: S.transcriptText }] },
    creator: null,
    comments: { toolId: 'treg.tiktok.video.comments', provider: 'anyapi', inputs: { url: P.post },
      fields: COMMENT_FIELDS(), dedupe: { path: '$.id' } },
  },
  instagram: {
    id: 'instagram', label: 'Instagram',
    search: {
      toolId: 'anyapi.instagram.search.reels', provider: null, query: 'query', inputs: {},
      fields: [field('$.url', P.post), field('$.username', P.author), field('$.caption', P.caption),
        field('$.views', P.views), field('$.likes', P.likes), field('$.comments', P.comments),
        field('$.reshares', P.shares), field('$.createdUtc', P.postedAt)],
      dedupe: { path: '$.url', also: ['$.shortcode'] },
    },
    formulas: [{ column: P.posted, formula: UNIX_DAY }],
    transcript: { toolId: 'anyapi.instagram.media_transcript', inputs: { url: P.post },
      outputs: [{ key: 'transcript', path: '$.output.data.transcripts[0].text', columnName: S.transcriptText,
        fromAnswer: true }] },
    creator: { toolId: 'treg.instagram.user.profile', inputs: { username: P.author },
      outputs: [{ key: 'followers', path: '$.output.followers', columnName: P.followers },
        { key: 'biography', path: '$.output.biography', columnName: S.bio }] },
    comments: { toolId: 'treg.instagram.post.comments', provider: 'anyapi', inputs: { url: P.post },
      fields: COMMENT_FIELDS(), dedupe: { path: '$.id' } },
  },
  youtube: {
    id: 'youtube', label: 'YouTube',
    search: {
      toolId: 'treg.youtube.search.videos', provider: 'tikhub', query: 'q', inputs: {},
      fields: [field('$.video_id', 'Video id'), field('$.author', P.author), field('$.title', P.caption),
        field('$.number_of_views', P.views), field('$.published_time', P.postedAt),
        field('$.channel_id', 'Channel id')],
      dedupe: { path: '$.video_id' },
    },
    formulas: [
      { column: P.post, formula: `{{Video id}} ? 'https://www.youtube.com/watch?v=' + {{Video id}} : ''` },
      { column: P.posted, formula: RELATIVE_DAY },
    ],
    transcript: { toolId: 'anyapi.youtube.video_transcript', inputs: { url: P.post },
      outputs: [{ key: 'output.data.transcript', path: '$.output.data.transcript', columnName: S.transcriptText }] },
    creator: { toolId: 'treg.youtube.channel.profile', inputs: { channel_id: 'Channel id' },
      outputs: [{ key: 'subscribers', path: '$.output.subscribers', columnName: P.followers },
        { key: 'description', path: '$.output.description', columnName: S.bio }] },
    comments: { toolId: 'treg.youtube.video.comments', provider: 'crawl4ai', inputs: { video_id: 'Video id' },
      fields: COMMENT_FIELDS(), dedupe: { path: '$.comment_id', also: ['$.url'] } },
  },
  x: {
    id: 'x', label: 'X',
    search: {
      toolId: 'anyapi.x.search.posts', provider: null, query: 'query', inputs: {},
      fields: [field('$.url', P.post), field('$.authorUsername', P.author), field('$.text', P.caption),
        field('$.viewCount', P.views), field('$.likeCount', P.likes), field('$.replyCount', P.comments),
        field('$.retweetCount', P.shares), field('$.createdUtc', P.postedAt), field('$.authorFollowers', P.followers)],
      dedupe: { path: '$.url', also: ['$.id'] },
    },
    formulas: [{ column: P.posted, formula: UNIX_DAY }],
    transcript: { toolId: 'anyapi.twitter.tweet_transcript', inputs: { url: P.post },
      outputs: [{ key: 'output.data.transcript', path: '$.output.data.transcript', columnName: S.transcriptText }] },
    creator: null,
    comments: { toolId: 'anyapi.x.post.comments', provider: null, inputs: { url: P.post },
      fields: COMMENT_FIELDS({ author: '$.authorHandle', likes: '$.likeCount', replies: '$.replyCount' }),
      dedupe: { path: '$.id', also: ['$.url'] } },
  },
};

// The columns a platform's Posts sheet starts with, in order: what its search fills, then its formulas.
export function postColumns(spec: PlatformSpec): string[] {
  const filled = spec.search.fields.map(f => f.columnName);
  const worked = spec.formulas.map(f => f.column);
  const order = [P.post, P.author, P.caption, P.views, P.likes, P.comments, P.shares, P.posted, P.followers];
  const known = new Set([...filled, ...worked]);
  const extra = [...filled, ...worked].filter(c => !(order as readonly string[]).includes(c));
  return [...order.filter(c => known.has(c)), ...extra.filter((c, i, a) => a.indexOf(c) === i), P.search,
    P.firstSeen];
}
