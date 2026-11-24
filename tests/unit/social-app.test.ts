// What the app reads for a social research table (services/social-options.ts, social-store.ts), against the
// repo's mock treg: the dialog's options list each platform treg serves with what a search and each step cost
// (the creator step 0 where the search gives the followers), and every sheet of a table (Searches, a Posts
// sheet, Comments) finds its record for the guide above the grid; another table's sheet finds none.
import assert from 'node:assert/strict'
import { tregKit } from './token-replay-treg-kit'
const kit = await tregKit('social-app')
const { db, uid, ok, done } = kit
const { socialOptions } = await import('../../server/src/services/social-options')
const { socialInputOf } = await import('../../server/src/lib/social/input')
const { createSocialTable } = await import('../../server/src/services/social-create')
const { socialForSheet } = await import('../../server/src/services/social-store')

await ok('the options: every platform treg serves, with a search\'s price and each step\'s', async () => {
  const options = await socialOptions()
  assert.deepEqual(options.map(o => o.platform), ['tiktok', 'instagram', 'youtube', 'x'])
  for (const o of options) {
    assert.ok(typeof o.searchUsd === 'number' && o.searchUsd > 0, `${o.platform} search ${o.searchUsd}`)
    assert.ok(typeof o.steps.transcript === 'number' && o.steps.transcript > 0, `${o.platform} transcript`)
    assert.ok(typeof o.steps.comments === 'number' && o.steps.comments > 0, `${o.platform} comments`)
  }
  const by = Object.fromEntries(options.map(o => [o.platform, o]))
  assert.equal(by.tiktok.steps.creator, 0, 'TikTok\'s search gives the followers')
  assert.equal(by.x.steps.creator, 0)
  assert.ok((by.instagram.steps.creator ?? 0) > 0 && (by.youtube.steps.creator ?? 0) > 0)
})

await ok('every sheet of a table finds its record; another table\'s sheet finds none', async () => {
  const input = socialInputOf({ topic: 'tea', platforms: ['tiktok', 'youtube'], steps: ['comments'] }, 'v1')
  assert.ok('ok' in input)
  const made = await createSocialTable(uid, input.ok)
  assert.ok('ok' in made, JSON.stringify(made))
  const t = made.ok
  for (const sheet of [t.searchesSheetId, t.postsSheets.tiktok!, t.postsSheets.youtube!, t.commentsSheetId!]) {
    assert.equal(socialForSheet(uid, sheet)?.id, t.id, sheet)
  }
  const other = db.prepare('SELECT id FROM sheets WHERE table_id != ? LIMIT 1').pluck().get(t.tableId) as
    string | undefined
  if (other) assert.equal(socialForSheet(uid, other), undefined)
  assert.equal(socialForSheet(uid, 'not-a-sheet'), undefined)
})

await done()
