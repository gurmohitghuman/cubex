// A social research table's "Creator's usual views" step (lib/social/usual.ts, platforms.ts), against the repo's
// mock treg with the job queue only recording:
//   - the formulas, in the real formula sandbox: Usual views is the median of the creator's recent posts' views,
//     leaving out this post (by its id, shortcode or video_id in the Post link) and posts with no views, blank
//     under 3 posts or with no list; Times usual is Views over it, to one decimal;
//   - making the table: on each Posts sheet, Recent posts (set up, not run) asks that platform's tool by the
//     Author's handle (YouTube's by the Channel id) with the fields and page it keeps, filling Recent views;
//     both formulas; a "3x over usual" view beside the active Top posts; nothing called;
//   - the dialog's options price the step on every platform.
import assert from 'node:assert/strict'
import { tregKit } from './token-replay-treg-kit'
const kit = await tregKit('social-usual')
const { db, uid, ok, done } = kit
const { compileFormula } = await import('../../server/src/lib/formula/refs')
const { formulaRow } = await import('../../server/src/lib/formula/cells')
const { FormulaSandbox } = await import('../../server/src/lib/formula/sandbox')
const { USUAL_FORMULA, TIMES_USUAL_FORMULA, STANDS_OUT_VIEW } = await import('../../server/src/lib/social/usual')
const { socialInputOf } = await import('../../server/src/lib/social/input')
const { createSocialTable } = await import('../../server/src/services/social-create')
const { socialOptions } = await import('../../server/src/services/social-options')
const { getSheetColumns } = await import('../../server/src/lib/sql-helpers')
const TREG = process.env.TREG_BASE_URL!
const calls = async () => ((await (await fetch(`${TREG}/__mock/requests`)).json()) as Array<{ path: string }>)
  .map(r => r.path).filter(p => p.startsWith('/call/'))

async function run(formula: string, rows: Array<Record<string, string>>): Promise<string[]> {
  const compiled = compileFormula(formula, ['Post', 'Views', 'Recent views', 'Usual views'])
  const sb = await FormulaSandbox.open(compiled)
  try {
    const r = sb.runRows(rows.map(row => formulaRow(compiled.inputs.map(c => row[c] ?? ''))), 1000)
    if (r.closed) throw new Error('The formula engine closed this formula before it answered.')
    return r.outcomes.map(o => (o.ok ? String(o.value) : `ERR ${o.error}`))
  } finally { sb.dispose() }
}
const list = (items: unknown[]) => JSON.stringify(items)
const tt = (id: string) => `https://www.tiktok.com/@someone/video/${id}`

await ok('Usual views: the median of the recent posts\' views, without this post or posts with no views', async () => {
  const recent = list([{ id: '100', views: 900000 }, { id: '101', views: 12000 }, { id: '102', views: 30000 },
    { id: '103', views: 25000 }, { id: '104', views: 41000 }, { id: '105', views: 0 }, { id: '106', views: 'n/a' }])
  assert.deepEqual(await run(USUAL_FORMULA, [
    { Post: tt('100'), 'Recent views': recent }, // 12000, 25000, 30000, 41000: (25000 + 30000) / 2
    { Post: tt('999'), 'Recent views': recent }, // 12000, 25000, 30000, 41000, 900000
    { Post: tt('100'), 'Recent views': list([{ id: '1', views: 5 }, { id: '100', views: 9 }, { id: '2', views: 7 }]) },
    { Post: tt('100'), 'Recent views': '' },
    { Post: tt('100'), 'Recent views': '⏭️ Not found' },
    { Post: tt('100'), 'Recent views': '{"views": 3}' },
    // Instagram's shortcode and YouTube's video_id, each in its Post link.
    { Post: 'https://www.instagram.com/reel/ABC123/', 'Recent views': list([{ shortcode: 'ABC123', views: 1e6 },
      { shortcode: 'X1', views: 10 }, { shortcode: 'X2', views: 20 }, { shortcode: 'X3', views: 40 }]) },
    { Post: 'https://www.youtube.com/watch?v=vid1', 'Recent views': list([{ video_id: 'vid1', views: 1e6 },
      { video_id: 'v2', views: 3 }, { video_id: 'v3', views: 4 }, { video_id: 'v4', views: 8 }]) },
  ]), ['27500', '30000', '', '', '', '', '20', '4'])
})

await ok('Times usual: Views over Usual views, to one decimal; blank without both', async () => {
  assert.deepEqual(await run(TIMES_USUAL_FORMULA, [
    { Views: '900000', 'Usual views': '25000' }, { Views: '450000', 'Usual views': '27500' },
    { Views: '300000', 'Usual views': '27500' }, { Views: '10', 'Usual views': '' }, { Views: '', 'Usual views': '5' },
    { Views: '0', 'Usual views': '5' },
  ]), ['36', '16.4', '10.9', '', '', ''])
})

const input = socialInputOf({ topic: 'morning routine', platforms: ['tiktok', 'instagram', 'youtube', 'x'],
  steps: ['usual'], min_views: 10000 }, 'v1')
assert.ok('ok' in input, JSON.stringify(input))
const made = await createSocialTable(uid, input.ok)
assert.ok('ok' in made, JSON.stringify(made))
const t = made.ok

interface StoredRun { setup_only: number; config: string }
const recentPosts = (sheetId: string) => db.prepare(`SELECT setup_only, config FROM http_runs WHERE sheet_id = ?
  AND master_column_name = 'Recent posts'`).get(sheetId) as StoredRun | undefined

await ok('making it: Recent posts set up on each Posts sheet with its platform\'s tool; the formulas', async () => {
  const want = {
    tiktok: ['anyapi.tiktok.user.videos', 'handle', 'Author', { fields: 'id,views', max_items: '30' },
      '$.output.data.videos'],
    instagram: ['anyapi.instagram.user.reels', 'handle', 'Author', { fields: 'shortcode,views', max_items: '30' },
      '$.output.data.reels'],
    youtube: ['crawl4ai.youtube.channel.videos', 'channel', 'Channel id', { limit: '30' }, '$.rows'],
    x: ['anyapi.x.user.posts.timeline', 'handle', 'Author', { fields: 'id,views', max_items: '30' },
      '$.output.data.tweets'],
  } as const
  for (const [platform, [toolId, inputName, column, values, path]] of Object.entries(want)) {
    const sheet = t.postsSheets[platform as keyof typeof want]!
    const cols = getSheetColumns(sheet, uid)
    assert.deepEqual(cols.slice(-4), ['Recent posts', 'Recent views', 'Usual views', 'Times usual'], platform)
    const r = recentPosts(sheet)
    assert.ok(r, `${platform}: Recent posts`)
    assert.equal(r!.setup_only, 2, platform)
    const config = JSON.parse(r!.config)
    const text = JSON.stringify(config)
    assert.equal(config.enrichment?.toolId, toolId, platform)
    assert.ok(text.includes(`{{${column}}}`), `${platform}: ${inputName} reads ${column}: ${text.slice(0, 400)}`)
    for (const v of Object.values(values)) assert.ok(text.includes(v), `${platform}: sends ${v}`)
    assert.ok(text.includes(path) && text.includes('Recent views'), `${platform}: fills Recent views from ${path}`)
    assert.match(text, new RegExp(`\\{\\{${column}\\}\\} is not empty`), `${platform}: runs where ${column} is set`)
    const formulas = db.prepare(`SELECT column_name FROM formula_columns WHERE sheet_id = ? AND column_name IN
      ('Usual views', 'Times usual') ORDER BY column_name`).pluck().all(sheet)
    assert.deepEqual(formulas, ['Times usual', 'Usual views'], platform)
  }
  assert.deepEqual(await calls(), [])
})

await ok('a "3x over usual" view beside the active Top posts', () => {
  const views = db.prepare(`SELECT v.name, v.id = s.active_view_id AS active FROM sheet_views v JOIN sheets s
    ON s.id = v.sheet_id WHERE v.sheet_id = ? ORDER BY v.name`).all(t.postsSheets.tiktok!) as
    Array<{ name: string; active: number }>
  const by = Object.fromEntries(views.map(v => [v.name, v.active]))
  assert.equal(STANDS_OUT_VIEW, '3x over usual')
  assert.equal(by['3x over usual'], 0, JSON.stringify(views))
  assert.equal(by['Top posts'], 1, JSON.stringify(views))
  const where = db.prepare('SELECT * FROM sheet_views WHERE sheet_id = ? AND name = ?')
    .get(t.postsSheets.tiktok!, '3x over usual')
  assert.match(JSON.stringify(where), /Times usual.*gte.*3/)
})

await ok('the dialog\'s options price the step on every platform', async () => {
  for (const o of await socialOptions()) {
    assert.ok(typeof o.steps.usual === 'number' && o.steps.usual > 0, `${o.platform}: ${o.steps.usual}`)
  }
})

await done()
