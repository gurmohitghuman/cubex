// A social research table's names and words (pure): its sheets, their columns,
// and what each one holds, for the sheet and column descriptions agents and
// people read (services/social-create.ts).
import { SOCIAL_STANDS_OUT_TIMES } from '../constants';

export const SOCIAL_SHEETS = { searches: 'Searches', comments: 'Comments' } as const;
export const postsSheetName = (label: string) => `${label} posts`;

export const SEARCH_COLUMNS = { words: 'Search words' } as const;
export const foundColumn = (label: string) => `${label} posts found`;

// Every Posts sheet's columns that every platform fills (a platform adds its own: platforms.ts).
export const POST_COLUMNS = {
  post: 'Post', author: 'Author', caption: 'Caption', views: 'Views', likes: 'Likes', comments: 'Comments',
  shares: 'Shares', postedAt: 'Posted at', posted: 'Posted', followers: 'Followers', search: 'Search',
  firstSeen: 'First seen',
} as const;

// The steps (set up, never run, by the template): each a column, or a few.
export const STEP_COLUMNS = {
  transcript: 'Transcript', transcriptText: 'Transcript text', // its status column, and what it fills
  breakdown: 'Breakdown', // the AI read's base name: "Breakdown (Status)" and its outputs
  hook: 'Hook', tension: 'Tension', payoff: 'Payoff', why: 'Why it works',
  creator: 'Creator', bio: 'Bio',
  commentsFound: 'Comments found',
  // The creator's usual views: their recent posts (its status column, and the list it fills), the median of
  // their views, and how many times that this post got (lib/social/usual.ts).
  recentPosts: 'Recent posts', recentViews: 'Recent views', usualViews: 'Usual views', timesUsual: 'Times usual',
} as const;

export const COMMENT_COLUMNS = {
  post: 'Post', platform: 'Platform', author: 'Author', text: 'Comment', likes: 'Likes', replies: 'Replies',
  reaction: 'Reaction', // the AI tag's base name: "Reaction (Output)"
} as const;

export const STEPS = ['transcript', 'breakdown', 'creator', 'usual', 'comments'] as const;
export type SocialStep = typeof STEPS[number];

export const SHEET_WORDS = {
  searches: 'What to search for: one row per search, and a column per platform that adds the posts it finds to '
    + 'that platform\'s sheet, keeping the posts found before. Running them again adds only new posts.',
  posts: (label: string) => `The ${label} posts the searches found, one row per post. The Top posts view keeps to `
    + 'the ones that pass the table\'s filters; run the steps on them.',
  comments: 'Comments on the posts, one row per comment, added by each Posts sheet\'s "Comments found" column.',
};

export const COLUMN_WORDS = {
  [POST_COLUMNS.post]: 'The post\'s link.',
  [POST_COLUMNS.views]: 'How many times it was watched, when the search answered.',
  [POST_COLUMNS.postedAt]: 'When it was posted, as the platform gave it.',
  [POST_COLUMNS.posted]: 'The day it was posted (worked out from Posted at).',
  [POST_COLUMNS.search]: 'The search words that found it.',
  [POST_COLUMNS.firstSeen]: 'The day of the Find posts that first found it.',
  [STEP_COLUMNS.transcriptText]: 'What is said in the video.',
  [STEP_COLUMNS.hook]: 'How the post grabs attention in its first seconds.',
  [STEP_COLUMNS.tension]: 'What keeps people watching.',
  [STEP_COLUMNS.payoff]: 'What they get at the end.',
  [STEP_COLUMNS.why]: 'Why it works, in a sentence or two.',
  [STEP_COLUMNS.bio]: 'The creator\'s bio.',
  [STEP_COLUMNS.recentViews]: 'The creator\'s recent posts and their views, as the platform gave them.',
  [STEP_COLUMNS.usualViews]: 'The creator\'s usual views: the middle of their recent posts\' views, leaving out '
    + 'this post.',
  [STEP_COLUMNS.timesUsual]: `How many times the creator's usual views this post got. ${SOCIAL_STANDS_OUT_TIMES} or `
    + 'more stands out.',
} as const;

// "Social: morning routine" (cut to fit; a number after it when the name is taken).
export function socialTableBase(topic: string, max: number): string {
  const base = `Social: ${topic.replace(/\s+/g, ' ').trim()}`;
  return base.length <= max ? base : `${base.slice(0, max - 1).trimEnd()}…`;
}

export const BREAKDOWN_PROMPT = 'Here is a {{platform}} post that did well.\n\nCaption: /Caption\nViews: /Views\n'
  + 'Transcript: /transcript_text\n\nIn plain words, say how its first seconds grab attention (Hook), what keeps '
  + 'people watching (Tension), what they get at the end (Payoff), and why it works. Keep each to one or two '
  + 'sentences. When there is no transcript, read the caption alone.';

export const REACTION_PROMPT = 'A comment on a social post: /Comment\n\nAnswer with one word for what the commenter '
  + 'does: compares (to something else), asks (a question), hates, loves, or other.';
