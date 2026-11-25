// "Creator's usual views" on a Posts sheet (pure): the creator's recent posts come back as one list in Recent
// views (each platform's tool: platforms.ts), and two free formulas follow it. Usual views is the middle of
// those posts' views (the median, so one viral post or a few brand-new ones don't move it), leaving out this
// post itself and posts with no views (an X repost shows 0), once there are enough to say. Times usual is this
// post's views over that, to one decimal. The "3x over usual" view keeps the posts that stand out.
// A list is matched to this post by the id each platform gives (id, Instagram's shortcode, YouTube's
// video_id), which every Post link holds.
import { SOCIAL_STANDS_OUT_TIMES, SOCIAL_USUAL_MIN_POSTS } from '../constants';
import type { WhereItem } from '../row-filter/where';
import { POST_COLUMNS as P, STEP_COLUMNS as S } from './names';

export const USUAL_FORMULA = `(() => {
  const list = {{${S.recentViews}}};
  if (!Array.isArray(list)) return '';
  const post = String({{${P.post}}} ?? '');
  const views = list.filter(p => p && typeof p === 'object')
    .filter(p => { const id = String(p.id ?? p.shortcode ?? p.video_id ?? ''); return !id || !post.includes(id); })
    .map(p => Number(p.views)).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (views.length < ${SOCIAL_USUAL_MIN_POSTS}) return '';
  const m = Math.floor(views.length / 2);
  return Math.round(views.length % 2 ? views[m] : (views[m - 1] + views[m]) / 2);
})()`;

export const TIMES_USUAL_FORMULA = `(() => { const v = Number({{${P.views}}}), u = Number({{${S.usualViews}}});
  return v > 0 && u > 0 ? Math.round(v / u * 10) / 10 : ''; })()`;

export const USUAL_FORMULAS = [
  { column: S.usualViews, formula: USUAL_FORMULA },
  { column: S.timesUsual, formula: TIMES_USUAL_FORMULA },
];

export const STANDS_OUT_VIEW = `${SOCIAL_STANDS_OUT_TIMES}x over usual`;
export const STANDS_OUT_WHERE: WhereItem[] = [
  { column: S.timesUsual, operator: 'gte', value: String(SOCIAL_STANDS_OUT_TIMES) },
];
