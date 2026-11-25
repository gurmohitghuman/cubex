import { test, expect } from '@playwright/test'
import { authedApi, makeAccessToken } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'
import { column } from './helpers-setups'
import { MOCK_TEAM_KEY, mockTreg, setTregKey } from './helpers-treg'

// A social research table over MCP (social_research), against the mock treg's social tools (made-up creators):
// create is free and runs nothing; find_posts is an estimate first, refused without max_cost_usd, then one run
// per platform adds its posts: TikTok's three, with Posted worked out from the Unix time and First seen this day;
// YouTube's with the link and the day worked out by its formulas. Running it again adds no post twice. A step set
// up on a Posts sheet runs through its column's run (control_run): TikTok's transcripts fill.
test('social_research: create, find posts, find again, run a step', async () => {
  test.setTimeout(180_000)
  const api = await authedApi()
  await setTregKey(api, MOCK_TEAM_KEY)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'social-research'))
  const made = await call(client, 'social_research', { action: 'create', topic: 'morning routine',
    platforms: ['tiktok', 'youtube'], steps: ['transcript', 'breakdown', 'comments'], posted_within_days: 30 })
  expect(made.table_name).toMatch(/^Social: morning routine/)
  expect(Object.keys(made.posts_sheets)).toEqual(['tiktok', 'youtube'])
  expect(made.next).toMatch(/Nothing was searched yet/)
  const tiktok = made.posts_sheets.tiktok, youtube = made.posts_sheets.youtube

  const est = await call(client, 'social_research', { action: 'find_posts', id: made.id })
  expect(est.estimate_only).toBe(true)
  expect(est.platforms.map((p: any) => p.platform)).toEqual(['tiktok', 'youtube'])
  expect(est.high_usd).toBeGreaterThan(0)
  expect(await callError(client, 'social_research', { action: 'find_posts', id: made.id, estimate_only: false }))
    .toMatch(/needs max_cost_usd/)

  const today = new Date().toISOString().slice(0, 10)
  const found = await call(client, 'social_research', { action: 'find_posts', id: made.id, estimate_only: false,
    max_cost_usd: est.high_usd })
  expect(found.day).toBe(today)
  expect(found.runs).toHaveLength(2)
  for (const r of found.runs) {
    await expect.poll(async () => (await call(client, 'get_run_status', { run_type: 'enrichment', run_id: r.run_id }))
      .status, { timeout: 30_000 }).toBe('completed')
  }
  await expect.poll(() => column(api, tiktok, 'Author'), { timeout: 15_000 })
    .toEqual(['sunny_side_studio', 'mila_mornings', 'calm_kettle'])
  expect(await column(api, tiktok, 'First seen')).toEqual([today, today, today])
  expect(await column(api, tiktok, 'Search')).toEqual(['morning routine', 'morning routine', 'morning routine'])
  await expect.poll(() => column(api, tiktok, 'Posted'), { timeout: 15_000 })
    .toEqual([1795000000, 1794740800, 1794481600].map(s => new Date(s * 1000).toISOString().slice(0, 10)))
  // A list run's rows are added just after it ends (the drain), so they're waited for.
  await expect.poll(async () => (await column(api, youtube, 'Video id')).length, { timeout: 15_000 }).toBeGreaterThan(0)
  const ytPosts = await column(api, youtube, 'Video id')
  await expect.poll(async () => (await column(api, youtube, 'Post'))[0], { timeout: 15_000 })
    .toBe(`https://www.youtube.com/watch?v=${ytPosts[0]}`)
  const day = (back: number) =>
    new Date(Date.parse(`${today}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10)
  await expect.poll(async () => (await column(api, youtube, 'Posted'))[0], { timeout: 15_000 }).toBe(day(1))

  // Again: every post is there already, so none is added twice.
  const again = await call(client, 'social_research', { action: 'find_posts', id: made.id, estimate_only: false,
    max_cost_usd: est.high_usd })
  for (const r of again.runs) {
    await expect.poll(async () => (await call(client, 'get_run_status', { run_type: 'enrichment', run_id: r.run_id }))
      .status, { timeout: 30_000 }).toBe('completed')
  }
  expect(await column(api, tiktok, 'Author')).toHaveLength(3)

  // A step: the transcript column's own run, on the rows not run yet.
  const sheet = await call(client, 'get_sheet', { sheet_id: tiktok, column_details: true })
  const transcript = sheet.column_details.find((d: { name: string }) => d.name === 'Transcript').fill
  expect(transcript.run_status).toBe('set_up')
  const rerun = await call(client, 'control_run', { action: 'rerun', run_type: 'enrichment', run_id: transcript.run_id,
    mode: 'empty' })
  await expect.poll(async () => (await call(client, 'get_run_status', { run_type: 'enrichment',
    run_id: rerun.run_id })).status, { timeout: 30_000 }).toBe('completed')
  expect(await column(api, tiktok, 'Transcript text'))
    .toEqual(Array(3).fill('Wake up, water first, then ten minutes outside.'))
})

// The creator's usual views: Recent posts asks each TikTok creator's recent posts by the Author's handle, keeping
// each post's id and views (one page), once per creator; Usual views leaves out this post (the mock's list holds
// the first post) and the post with no views, and Times usual divides. YouTube's asks by the Channel id.
test('social_research: the creator\'s usual views and how many times that each post got', async () => {
  test.setTimeout(180_000)
  const api = await authedApi()
  await setTregKey(api, MOCK_TEAM_KEY)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'social-usual'))
  const made = await call(client, 'social_research', { action: 'create', topic: 'slow mornings',
    platforms: ['tiktok', 'youtube'], steps: ['usual'] })
  const tiktok = made.posts_sheets.tiktok, youtube = made.posts_sheets.youtube
  const est = await call(client, 'social_research', { action: 'find_posts', id: made.id })
  const found = await call(client, 'social_research', { action: 'find_posts', id: made.id, estimate_only: false,
    max_cost_usd: est.high_usd })
  for (const r of found.runs) {
    await expect.poll(async () => (await call(client, 'get_run_status', { run_type: 'enrichment', run_id: r.run_id }))
      .status, { timeout: 30_000 }).toBe('completed')
  }
  await expect.poll(() => column(api, tiktok, 'Author'), { timeout: 15_000 })
    .toEqual(['sunny_side_studio', 'mila_mornings', 'calm_kettle'])
  await expect.poll(async () => (await column(api, youtube, 'Channel id')).length, { timeout: 15_000 })
    .toBeGreaterThan(0)

  await mockTreg.reset()
  const recentRun = async (sheetId: string) => {
    const sheet = await call(client, 'get_sheet', { sheet_id: sheetId, column_details: true })
    const fill = sheet.column_details.find((d: { name: string }) => d.name === 'Recent posts').fill
    expect(fill.run_status).toBe('set_up')
    const rerun = await call(client, 'control_run', { action: 'rerun', run_type: 'enrichment', run_id: fill.run_id,
      mode: 'empty' })
    await expect.poll(async () => (await call(client, 'get_run_status', { run_type: 'enrichment',
      run_id: rerun.run_id })).status, { timeout: 30_000 }).toBe('completed')
  }
  await recentRun(tiktok)
  const asked = (await mockTreg.requests()).filter(r => r.path === '/call/anyapi.tiktok.user.videos')
  expect(asked.map(r => JSON.parse(r.body).handle).sort()).toEqual(['calm_kettle', 'mila_mornings',
    'sunny_side_studio'])
  for (const r of asked) expect(new URLSearchParams(r.query).toString()).toBe('fields=id%2Cviews&max_items=30')
  // 12000 ... 41000 and the first post's 900000; the first post leaves itself out.
  await expect.poll(async () => (await column(api, tiktok, 'Usual views')).map(String), { timeout: 15_000 })
    .toEqual(['25000', '27500', '27500'])
  await expect.poll(async () => (await column(api, tiktok, 'Times usual')).map(String), { timeout: 15_000 })
    .toEqual(['36', '16.4', '10.9'])

  await recentRun(youtube)
  const channels = (await mockTreg.requests()).filter(r => r.path === '/call/crawl4ai.youtube.channel.videos')
    .map(r => JSON.parse(r.body))
  expect(channels.length).toBeGreaterThan(0)
  expect(channels.every(b => /^UC\d+sample$/.test(b.channel) && b.limit === 30)).toBe(true)
  const views = (await column(api, youtube, 'Views')).map(Number)
  // 1500, 3000, 4500, 6000, 9000.
  await expect.poll(async () => (await column(api, youtube, 'Usual views')).map(String), { timeout: 15_000 })
    .toEqual(views.map(() => '4500'))
  // Times usual follows Usual views, a moment after it.
  await expect.poll(async () => (await column(api, youtube, 'Times usual')).map(String), { timeout: 15_000 })
    .toEqual(views.map(v => String(Math.round(v / 4500 * 10) / 10)))
  const shown = await call(client, 'read_rows', { sheet_id: tiktok, view: '3x over usual' })
  expect(shown.rows.length).toBe(3)
})
