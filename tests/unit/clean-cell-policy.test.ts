// What a clean column shows in its preview and writes in its fill both go
// through the cell policy (stripControlChars): a source cell that holds a
// character the policy strips (stored before the policy, say) and that the
// cleaner hands back as it came shows and is written without it. C1 stays.
import assert from 'node:assert/strict'
import { undoKit } from './run-undo-kit'
const { db, uid, ok, done, idle, sheet } = undoKit('clean-cell-policy')
const { previewCleanColumn } = await import('../../server/src/services/clean-preview')
const { startCleanColumn } = await import('../../server/src/services/clean-column')
const { waitForCleanFill } = await import('../../server/src/services/clean-fill')

const HELD = 'a\u202Eb\u0085c'
const sid = sheet([{ Name: HELD }, { Name: 'Caf\u00C3\u00A9' }], ['Name'])

await ok('the preview shows what the fill writes: no direction control, C1 kept', () => {
  const out = previewCleanColumn(uid, sid, { source: 'Name', cleaner: 'fix_encoding' })
  assert.ok('ok' in out, JSON.stringify(out))
  if (!('ok' in out)) return
  assert.deepEqual(out.ok.samples, [
    { row: 0, before: HELD, after: 'ab\u0085c' },
    { row: 1, before: 'Caf\u00C3\u00A9', after: 'Caf\u00E9' },
  ])
})

await ok('the fill writes the same', async () => {
  const started = await startCleanColumn(uid, sid, { source: 'Name', cleaner: 'fix_encoding' })
  assert.ok('ok' in started, JSON.stringify(started))
  if (!('ok' in started)) return
  await waitForCleanFill(started.ok.id, 5_000)
  await idle(sid)
  const cells = db.prepare(`SELECT json_extract(data, '$."Name (clean)"') FROM rows WHERE sheet_id = ?
    ORDER BY row_index`).pluck().all(sid)
  assert.deepEqual(cells, ['ab\u0085c', 'Caf\u00E9'])
})

done()
