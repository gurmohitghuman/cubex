// Over 200 lines: one table made and searched, each step on the state the one before left.
// A social research table (services/social-create.ts, social-find.ts, social-agent.ts) against the repo's mock
// treg, the job queue only recording (no search runs):
//   - the body: a topic and platforms are needed, steps and filters only as given, posts per search capped;
//   - making it: Searches with a row per search and a list column per platform (set up, not run), a Posts sheet
//     per platform with its search's columns, its formulas and the steps picked (set up, not run: no model on
//     the AI steps), Comments with its reaction tag, a Top posts view made active where there are filters, the
//     record, one History line; nothing paid called and no run;
//   - Find posts' estimate: free, each platform priced; a start under its most is refused with the estimate now
//     and starts nothing; at its most, one run per platform keeping the posts found before, First seen this day,
//     each run's spend limit its platform's most, and the Top posts view's day moved; a platform still searching
//     refuses the next one.
import assert from 'node:assert/strict'
import { tregKit } from './token-replay-treg-kit'
const kit = await tregKit('social-research')
const { db, uid, ok, done } = kit
const { socialInputOf } = await import('../../server/src/lib/social/input')
const { createSocialTable } = await import('../../server/src/services/social-create')
const { estimateFindPosts, startFindPosts } = await import('../../server/src/services/social-find')
const { loadSocial } = await import('../../server/src/services/social-store')
const { getSheetColumns } = await import('../../server/src/lib/sql-helpers')
const TREG = process.env.TREG_BASE_URL!
const calls = async () => ((await (await fetch(`${TREG}/__mock/requests`)).json()) as Array<{ path: string }>)
  .map(r => r.path).filter(p => p.startsWith('/call/'))
const resetCalls = () => fetch(`${TREG}/__mock/reset`, { method: 'POST' })
const runs = (sheetId: string, setupOnly: number) => db.prepare(`SELECT COUNT(*) FROM http_runs WHERE sheet_id = ?
  AND setup_only = ?`).pluck().get(sheetId, setupOnly) as number
const input = (b: Record<string, unknown>) => {
  const i = socialInputOf(b, 'v1')
  if ('error' in i) throw new Error(i.error)
  return i.ok
}
const refusal = (b: Record<string, unknown>) => { const i = socialInputOf(b, 'v1'); return 'error' in i ? i.error : '' }

await ok('the body: a topic and platforms needed; steps and filters only as given', () => {
  assert.match(refusal({ platforms: ['tiktok'] }), /^topic is required/)
  assert.match(refusal({ topic: 'x', platforms: [] }), /platforms lists one or more of tiktok, instagram, youtube, x/)
  assert.match(refusal({ topic: 'x', platforms: ['myspace'] }), /platforms lists/)
  assert.match(refusal({ topic: 'x', platforms: ['x'], steps: ['dance'] }), /steps lists any of transcript/)
  assert.match(refusal({ topic: 'x', platforms: ['x'], posts_per_search: 99 }), /posts_per_search must be a whole/)
  assert.match(refusal({ topic: 'x', platforms: ['x'], minViews: 3 }), /Unknown field minViews/)
  const i = input({ topic: '  morning   routine ', platforms: ['tiktok', 'tiktok'] })
  assert.deepEqual([i.topic, i.searches, i.platforms, i.steps, i.minViews, i.postedWithinDays, i.perSearch],
    ['morning routine', ['morning routine'], ['tiktok'], [], null, null, 30])
})

const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10)
await resetCalls()
const made = await createSocialTable(uid, input({
  topic: 'morning routine', searches: ['morning routine', '5am club'],
  platforms: ['tiktok', 'instagram', 'youtube', 'x'],
  steps: ['transcript', 'breakdown', 'creator', 'comments'], min_views: 10000, posted_within_days: 7,
}))
assert.ok('ok' in made, JSON.stringify(made))
const t = made.ok
const sheetNames = () => db.prepare('SELECT name FROM sheets WHERE table_id = ? ORDER BY position').pluck()
  .all(t.tableId) as string[]

await ok('making it: the sheets, the searches, every run column set up and none run, nothing paid called', async () => {
  assert.equal(t.tableName, 'Social: morning routine')
  assert.deepEqual(sheetNames(),
    ['Searches', 'TikTok posts', 'Instagram posts', 'YouTube posts', 'X posts', 'Comments'])
  assert.deepEqual(getSheetColumns(t.searchesSheetId, uid),
    ['Search words', 'TikTok posts found', 'Instagram posts found', 'YouTube posts found', 'X posts found'])
  const words = db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
    .all(t.searchesSheetId).map(d => JSON.parse(d as string)['Search words'])
  assert.deepEqual(words, ['morning routine', '5am club'])
  assert.equal(runs(t.searchesSheetId, 2), 4)
  assert.equal(runs(t.searchesSheetId, 0), 0)
  assert.deepEqual(await calls(), [])
})

await ok('each Posts sheet: its search\'s columns, its formulas, the steps picked; Comments with its tag', () => {
  const tt = getSheetColumns(t.postsSheets.tiktok!, uid)
  assert.deepEqual(tt, ['Post', 'Author', 'Caption', 'Views', 'Likes', 'Comments', 'Shares', 'Posted', 'Followers',
    'Posted at', 'Search', 'First seen', 'Transcript', 'Transcript text', 'Breakdown (Status)', 'Hook', 'Tension',
    'Payoff', 'Why it works', 'Comments found'], 'TikTok: no creator step (its search has the followers)')
  const yt = getSheetColumns(t.postsSheets.youtube!, uid)
  for (const c of ['Video id', 'Channel id', 'Creator', 'Followers', 'Bio']) assert.ok(yt.includes(c), c)
  const formulas = db.prepare('SELECT column_name FROM formula_columns WHERE sheet_id = ? ORDER BY column_name').pluck()
  assert.deepEqual(formulas.all(t.postsSheets.youtube!), ['Post', 'Posted'])
  assert.deepEqual(formulas.all(t.postsSheets.tiktok!), ['Posted'])
  // Transcript, creator (not TikTok's) and comments per platform; none run.
  assert.equal(runs(t.postsSheets.tiktok!, 2), 2)
  assert.equal(runs(t.postsSheets.youtube!, 2), 3)
  const ai = db.prepare(`SELECT column_name, model, setup_only, output_columns FROM ai_runs WHERE sheet_id = ?`)
  const breakdown = ai.get(t.postsSheets.tiktok!) as { column_name: string; model: string | null; setup_only: number;
    output_columns: string }
  assert.equal(breakdown.column_name, 'Breakdown (Status)')
  assert.equal(breakdown.model, null)
  assert.equal(breakdown.setup_only, 2)
  assert.deepEqual(JSON.parse(breakdown.output_columns).map((o: { columnName: string }) => o.columnName),
    ['Hook', 'Tension', 'Payoff', 'Why it works'])
  assert.deepEqual(getSheetColumns(t.commentsSheetId!, uid),
    ['Post', 'Platform', 'Author', 'Comment', 'Likes', 'Replies', 'Reaction (Output)'])
  assert.equal((ai.get(t.commentsSheetId!) as { column_name: string }).column_name, 'Reaction (Output)')
})

// The active view's filters live on the sheet (lib/views/filters.ts).
const view = (sheetId: string) => db.prepare(`SELECT v.name, s.empty_filter, s.column_filters, s.row_filter
  FROM sheets s JOIN sheet_views v ON v.id = s.active_view_id WHERE s.id = ?`).get(sheetId) as
  { name: string; column_filters: string | null; row_filter: string | null } | undefined
await ok('a Top posts view, active, with the filters; the record; one History line', () => {
  const v = view(t.postsSheets.tiktok!)
  assert.equal(v?.name, 'Top posts')
  const text = JSON.stringify(v)
  assert.match(text, /Views/)
  assert.ok(text.includes(day(7)), `posted in the last 7 days of the day it was made: ${text}`)
  const rec = loadSocial(uid, t.id)!
  assert.equal(rec.table_id, t.tableId)
  assert.deepEqual(JSON.parse(rec.steps), ['transcript', 'breakdown', 'creator', 'comments'])
  const lines = db.prepare(`SELECT action, summary FROM sheet_changes WHERE sheet_id IN (SELECT id FROM sheets
    WHERE table_id = ?)`).all(t.tableId) as Array<{ action: string; summary: string }>
  assert.deepEqual(lines, [{ action: 'social_created',
    summary: 'Made the social research table for "morning routine": TikTok, Instagram, YouTube, X' }])
})

let high = 0
await ok('Find posts\' estimate: free, each platform priced on both searches', async () => {
  await resetCalls()
  const e = await estimateFindPosts(uid, loadSocial(uid, t.id)!)
  assert.ok('ok' in e, JSON.stringify(e))
  assert.equal(e.ok.searches, 2)
  assert.deepEqual(e.ok.platforms.map(p => [p.platform, p.rows]), [['tiktok', 2], ['instagram', 2], ['youtube', 2],
    ['x', 2]])
  assert.ok(e.ok.highUsd > 0 && e.ok.priceKnown, JSON.stringify(e.ok))
  high = e.ok.highUsd
  assert.deepEqual(await calls(), [])
  assert.equal(runs(t.searchesSheetId, 0), 0)
})

await ok('a start under its most is refused with the estimate now, and starts nothing', async () => {
  const out = await startFindPosts(uid, loadSocial(uid, t.id)!, { maxCostUsd: high / 2 })
  assert.ok('fail' in out && out.fail === 'over_ceiling' && out.estimate, JSON.stringify(out))
  assert.match(out.message, /^Finding posts could now cost up to \$/)
  assert.equal(runs(t.searchesSheetId, 0), 0)
})

// A view made days ago: Find posts moves its day to the last 7 days of this one.
db.prepare(`UPDATE sheets SET column_filters = replace(column_filters, ?, '2020-01-01'),
  row_filter = replace(row_filter, ?, '2020-01-01') WHERE id = ?`).run(day(7), day(7), t.postsSheets.tiktok!)
assert.match(JSON.stringify(view(t.postsSheets.tiktok!)), /2020-01-01/)
await ok('at its most: a run per platform, keeping the posts found before, First seen this day', async () => {
  const out = await startFindPosts(uid, loadSocial(uid, t.id)!, { maxCostUsd: high, timeZone: 'UTC' })
  assert.ok('ok' in out, JSON.stringify(out))
  assert.equal(out.ok.day, day(0))
  assert.deepEqual(out.ok.runs.map(r => r.platform), ['tiktok', 'instagram', 'youtube', 'x'])
  assert.equal(runs(t.searchesSheetId, 0), 4)
  const configs = db.prepare(`SELECT config FROM http_runs WHERE sheet_id = ? AND setup_only = 0`).pluck()
    .all(t.searchesSheetId).map(c => JSON.parse(c as string).enrichment)
  for (const e of configs) {
    assert.equal(e.list.keep, true)
    assert.ok(e.list.copy.some((c: { to: string; value?: string }) => c.to === 'First seen' && c.value === day(0)))
    assert.ok(typeof e.spendLimitUsd === 'number' && e.spendLimitUsd > 0)
  }
  const moved = JSON.stringify(view(t.postsSheets.tiktok!))
  assert.ok(moved.includes(day(7)) && !moved.includes('2020-01-01'), `Top posts: the last 7 days of this day: ${moved}`)
})

await ok('a platform still searching refuses the next Find posts', async () => {
  const again = await estimateFindPosts(uid, loadSocial(uid, t.id)!)
  assert.ok('fail' in again && again.fail === 'conflict', JSON.stringify(again))
  assert.match(again.message, /"TikTok posts found" is still searching/)
})

await done()
