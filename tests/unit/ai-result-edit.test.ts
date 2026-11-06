// Editing a stored AI result (PUT /api/ai/results/:id, services/ai-result-edit.ts):
// a live sheet's result changes, one whose sheet is in the trash doesn't, and
// the check reads the result's own run by its key rather than listing every
// run the user has (auto-run adds a run per batch, so that list only grows).
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { trashKit } from './trash-kit'
import editMod from '../../server/src/services/ai-result-edit'
import sheetsMod from '../../server/src/services/trash-sheets'
const { editAiResult } = editMod as typeof import('../../server/src/services/ai-result-edit')
const { trashSheet } = sheetsMod as typeof import('../../server/src/services/trash-sheets')
const { db, uid, tid, ok, done, fixture } = trashKit('ai-result-edit')

const resultOf = (sid: string) => db.prepare(`SELECT x.id, x.output_value AS value, x.status FROM ai_results x
  JOIN ai_runs r ON r.id = x.run_id WHERE r.sheet_id = ? LIMIT 1`).get(sid) as
  { id: string; value: string | null; status: string | null }

await ok("a live sheet's result changes; another account's, or one nobody has, doesn't", () => {
  const sid = fixture(3)
  const r = resultOf(sid)
  assert.equal(editAiResult(uuid(), r.id, 'theirs', 'accepted'), false)
  assert.equal(editAiResult(uid, uuid(), 'nobody', 'accepted'), false)
  assert.equal(editAiResult(uid, r.id, 'edited', 'accepted'), true)
  assert.deepEqual(resultOf(sid), { id: r.id, value: 'edited', status: 'accepted' })
})

await ok("a result of a sheet in the trash doesn't change", () => {
  const sid = fixture(3)
  fixture(1)                               // so the sheet isn't its table's last
  const r = resultOf(sid)
  const out = trashSheet(uid, tid, sid)
  assert.ok('ok' in out, JSON.stringify(out))
  assert.equal(editAiResult(uid, r.id, 'edited', 'accepted'), false)
  assert.deepEqual(resultOf(sid), r)
})

await ok("the check reads the result's own run by its key, not a list of the user's runs", () => {
  const real = db.prepare.bind(db)
  const seen: string[] = []
  db.prepare = ((sql: string) => { seen.push(sql); return real(sql) }) as typeof db.prepare
  try { editAiResult(uid, uuid(), 'x', 'accepted') } finally { db.prepare = real }
  const sql = seen.find(s => /UPDATE ai_results/.test(s))
  assert.ok(sql, 'the edit ran its update')
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('v', 's', 'i', 'u', 'u') as Array<{ detail: string }>)
    .map(p => p.detail)
  assert.ok(!plan.some(d => /LIST SUBQUERY/.test(d)), plan.join('\n'))
  assert.ok(plan.some(d => /SEARCH r USING .*\(id=\?\)/.test(d)), plan.join('\n'))
})

done()
