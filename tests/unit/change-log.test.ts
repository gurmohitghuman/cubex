// A sheet's change log (lib/change-log.ts, services/sheet-history.ts, migration
// 037). Pins: a line records who made the change (the app, a token by name over
// the API or MCP, Cubex itself) through AsyncLocalStorage across awaits; steps
// a logged change sets off log nothing; a line for a missing sheet is dropped,
// never thrown; history pages newest first by id, narrows to a column and says
// whether rows it names are still in the trash; lines past 90 days are pruned;
// the actor survives express.json (raw-body keeps the async context).
import assert from 'node:assert/strict'
import express from 'express'
import logMod from '../../server/src/lib/change-log'
import actorMod from '../../server/src/lib/actor'
import historyMod from '../../server/src/services/sheet-history'
import { trashKit } from './trash-kit'
const { logSheetChange, withoutChangeLog, logRunControl } = logMod as typeof import('../../server/src/lib/change-log')
const { runAs, actAs, currentActor } = actorMod as typeof import('../../server/src/lib/actor')
const { readSheetHistory, pruneChangeLog, historyAsk } =
  historyMod as typeof import('../../server/src/services/sheet-history')
const { db, uid, ok, done, fixture, del } = trashKit('change-log')

await ok('who: the app, a token over the API or MCP, or Cubex; carried across awaits', async () => {
  const sid = fixture(2)
  logSheetChange(sid, uid, 'column_added', 'Added the column "A"', { column: 'A' })
  await runAs({ via: 'app', tokenName: null }, async () => {
    await new Promise(r => setTimeout(r, 1))
    logSheetChange(sid, uid, 'column_added', 'Added the column "B"', { column: 'B' })
  })
  await runAs({ via: 'mcp', tokenName: 'Agent' }, async () => {
    await Promise.resolve()
    logSheetChange(sid, uid, 'column_deleted', 'Deleted the column "A"', { column: 'A' })
  })
  runAs({ via: 'api', tokenName: 'Zapier' }, () => logSheetChange(sid, uid, 'sheet_renamed', 'Renamed'))
  const page = readSheetHistory(sid, uid)
  assert.deepEqual(page.changes.map(c => c.by),
    ['the token "Zapier" (the API)', 'the token "Agent" (MCP)', 'the app', 'Cubex'])
  assert.equal(page.kept_days, 90)
  assert.match(page.changes[0].at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
  assert.equal(currentActor().via, 'cubex', 'outside a request it is Cubex')
})

await ok('steps of a logged change log nothing; Cubex stopping a run logs nothing', async () => {
  const sid = fixture(1)
  await withoutChangeLog(async () => {
    await Promise.resolve()
    logSheetChange(sid, uid, 'run_started', 'quiet')
  })
  logRunControl(sid, uid, 'run_stopped', 'Col', 'run1')
  runAs({ via: 'app', tokenName: null }, () => logRunControl(sid, uid, 'run_stopped', 'Col', 'run2'))
  assert.deepEqual(readSheetHistory(sid, uid).changes.map(c => c.summary), ['Stopped the run of "Col"'])
})

await ok('a line for a missing sheet is dropped, never thrown', () => {
  assert.equal(logSheetChange('no-such-sheet', uid, 'column_added', 'x'), null)
})

await ok('pages newest first, narrows to a column, and says what is still in the trash', () => {
  const sid = fixture(6)
  for (let i = 0; i < 5; i++) logSheetChange(sid, uid, 'column_added', `Added ${i}`, { column: i % 2 ? 'Odd' : 'Even' })
  const first = readSheetHistory(sid, uid, { limit: 2 })
  assert.deepEqual(first.changes.map(c => c.summary), ['Added 4', 'Added 3'])
  const next = readSheetHistory(sid, uid, { limit: 2, before: first.next_before! })
  assert.deepEqual(next.changes.map(c => c.summary), ['Added 2', 'Added 1'])
  assert.deepEqual(readSheetHistory(sid, uid, { column: 'Odd' }).changes.map(c => c.summary), ['Added 3', 'Added 1'])
  const kept = del(sid, [0]).trashId!
  const gone = del(sid, [2]).trashId!
  db.prepare('DELETE FROM trash_items WHERE id = ?').run(gone)
  const lines = readSheetHistory(sid, uid, { limit: 2 }).changes
  assert.deepEqual(lines.map(c => [c.detail?.trash_id, c.in_trash]), [[gone, false], [kept, true]])
  assert.deepEqual(historyAsk({ before: '0' }), { error: 'before must be a positive whole number (a change id).' })
})

await ok('lines older than 90 days are pruned', async () => {
  const sid = fixture(1)
  logSheetChange(sid, uid, 'column_added', 'old')
  logSheetChange(sid, uid, 'column_added', 'new')
  db.prepare(`UPDATE sheet_changes SET at = datetime('now', '-91 days') WHERE sheet_id = ? AND summary = 'old'`)
    .run(sid)
  await pruneChangeLog()
  assert.deepEqual(readSheetHistory(sid, uid).changes.map(c => c.summary), ['new'])
})

await ok('the actor survives express.json and a route that awaits', async () => {
  const app = express()
  app.use(actAs(() => ({ via: 'api', tokenName: 'T' })))
  app.use(express.json({ limit: '1mb' }))
  app.post('/x', async (_req, res) => { await new Promise(r => setTimeout(r, 1)); res.json(currentActor()) })
  const server = app.listen(0)
  try {
    const port = (server.address() as { port: number }).port
    const r = await fetch(`http://127.0.0.1:${port}/x`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(200_000) }),
    })
    assert.deepEqual(await r.json(), { via: 'api', tokenName: 'T' })
  } finally { server.close() }
})

done()
