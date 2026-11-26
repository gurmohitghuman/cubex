// Unit test for lib/enrich-search-order.ts: the order the drawer and search_enrichments list a search's tools in,
// from treg's ranking. Pure: no DB, no network. The shapes are treg's live answer for "tiktok viral videos" on
// 2026-11-24, cut down: trending feeds and a user's videos (five providers) came before any search.
import assert from 'node:assert/strict'
import orderMod from '../../server/src/lib/enrich-search-order'
const { firstOfEachJob, searchOrder } = orderMod as typeof import('../../server/src/lib/enrich-search-order')

interface T { id: string; capability: string | null; platformLabel: string | null; needsOwnKey: boolean;
  platform: string | null }
const tool = (id: string, capability: string | null, platform: string | null, needsOwnKey = false): T => ({
  id, capability, platform, needsOwnKey,
  platformLabel: platform === 'x' ? 'X (Twitter)' : platform === 'google' ? 'Google Keyword Data' : platform,
})
const order = (tools: T[], query: string, shown: string[] = []) =>
  searchOrder(tools, query, t => t.platform, shown).map(t => t.id)

let failures = 0
function check(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) } catch (e) { failures++; console.log('FAIL', label, (e as Error).message) }
}

const viral = [
  tool('trending', 'tiktok.feed.home', 'tiktok'), tool('charts', 'tiktok.music.charts', 'tiktok'),
  tool('yt.trending', 'youtube.trending.videos', 'youtube'), tool('treg.user', 'tiktok.user.videos', 'tiktok'),
  tool('crawl.user', 'tiktok.user.videos', 'tiktok'), tool('anyapi.user', 'tiktok.user.videos', 'tiktok'),
  tool('hashtag', 'tiktok.hashtag.videos', 'tiktok'), tool('treg.search', 'tiktok.search.videos', 'tiktok'),
  tool('anyapi.search', 'tiktok.search.videos', 'tiktok'), tool('odd', null, 'tiktok'),
]

check('each job\'s first tool, then the job\'s other providers, each in treg\'s order', () => {
  assert.deepEqual(firstOfEachJob(viral).map(t => t.id), ['trending', 'charts', 'yt.trending', 'treg.user',
    'hashtag', 'treg.search', 'odd', 'crawl.user', 'anyapi.user', 'anyapi.search'])
  assert.deepEqual(firstOfEachJob([]), [])
})

check('"tiktok viral videos": TikTok\'s tools first, so its search is in the first five', () => {
  const got = order(viral, 'tiktok viral videos')
  assert.deepEqual(got.slice(0, 6), ['trending', 'charts', 'treg.user', 'hashtag', 'treg.search', 'odd'])
  assert.deepEqual(got.slice(6), ['crawl.user', 'anyapi.user', 'anyapi.search', 'yt.trending'],
    'TikTok\'s other providers, then YouTube\'s trending')
})

check('a platform named by the name in brackets in its label ("X (Twitter)")', () => {
  const tools = [tool('maps', 'google.maps.posts', 'google'), tool('x.followers', 'x.user.followers', 'x')]
  assert.deepEqual(order(tools, 'twitter followers'), ['x.followers', 'maps'])
  assert.deepEqual(order(tools, 'x followers'), ['x.followers', 'maps'])
  // A word of a label outside brackets names nothing ("keyword" in "Google Keyword Data").
  assert.deepEqual(order(tools, 'keyword followers'), ['maps', 'x.followers'])
})

check('no platform named: treg\'s order, each job\'s first tool first', () => {
  const tools = [tool('verify', 'people.email.verify', 'people'), tool('find', 'people.email.find', 'people'),
    tool('verify2', 'people.email.verify', 'people'), tool('domain', 'companies.email_domain.find', 'companies')]
  assert.deepEqual(order(tools, 'find email'), ['verify', 'find', 'domain', 'verify2'])
})

check('tools needing the team\'s own key last, whatever platform', () => {
  const tools = [tool('own.search', 'tiktok.search.videos', 'tiktok', true), tool('yt', 'youtube.search', 'youtube'),
    tool('tt', 'tiktok.user.videos', 'tiktok')]
  assert.deepEqual(order(tools, 'tiktok videos'), ['tt', 'yt', 'own.search'])
})

check('a Popular job shown above the results counts as its job\'s first', () => {
  const tools = [tool('crawl.people', 'people.search', 'people'), tool('email', 'people.email.find', 'people')]
  assert.deepEqual(order(tools, 'people at a company', ['people.search']), ['email', 'crawl.people'])
})

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall enrich-search-order checks passed')
