// Open roles' start answers at once (CLAUDE.md: run start and cancel answer at once), on a sheet big enough that the
// start's setup of its rows still holds the sheet when it answers: the count isn't waited for (lookups_left says it
// comes), and it is added in the background once the sheet is free (services/open-roles-lookups.ts). Before, the
// start waited up to 15 s for that setup.
import assert from 'node:assert/strict'
import { tregKit } from './token-replay-treg-kit'
const kit = await tregKit('open-roles-start')
const { db, uid, ok, done } = kit
const { parseOpenRoles } = await import('../../server/src/lib/hiring/open-roles-input')
const { openRoles } = await import('../../server/src/services/open-roles')
const { OPEN_ROLES } = await import('../../server/src/lib/hiring/names')
const { sheetBusyWith } = await import('../../server/src/lib/sheet-busy')

const ROWS = 20_000
const o = parseOpenRoles({ websiteColumn: 'Website', roles: ['SDR'], country: 'US' })
assert.ok(typeof o === 'object', String(o))
const count = (sid: string) => db.prepare(`SELECT column_name FROM lookup_columns WHERE sheet_id = ?
  AND returns = 'count' AND source_column = 'Website'`).pluck().all(sid) as string[]

await ok(`a start on ${ROWS.toLocaleString('en-US')} rows answers while their setup holds the sheet; the count comes `
  + 'after', async () => {
  const sid = kit.sheet(Array.from({ length: ROWS }, (_, i) => ({ Website: `c${i}.example` })), ['Website'])
  const est = await openRoles(uid, sid, { ...o, estimateOnly: true, maxCostUsd: null, timeZone: null })
  assert.ok('ok' in est && 'estimate' in est.ok, JSON.stringify(est))
  const s = await openRoles(uid, sid, { ...o, estimateOnly: false, maxCostUsd: est.ok.estimate.highUsd,
    timeZone: null })
  const holding = sheetBusyWith(sid)
  assert.ok('ok' in s && 'started' in s.ok, JSON.stringify(s))
  assert.ok(holding, 'the rows\' setup still held the sheet when the start answered')
  assert.deepEqual(s.ok.started.lookups, [])
  assert.match(s.ok.started.lookupsLeft ?? '', /once the sheet is free/)
  for (let tries = 0; count(sid).length === 0; tries++) {
    assert.ok(tries < 400, 'the count was never added')
    await kit.idle(sid)
    await new Promise(r => setTimeout(r, 50))
  }
  assert.deepEqual(count(sid), [OPEN_ROLES.count])
})

done()
