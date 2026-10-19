// The spend cap per access token (migration 042, services/token-spend.ts),
// against a migrated throwaway DB: the cap's words and parsing; a run started
// for a token carries it into its usage record; token_spend keeps each
// token's run_usage sums (AI, the user's own provider key, treg, a waterfall's
// AI steps, previews and AI helpers) and ONLY EVER GOES UP: an undo, rows,
// columns or a sheet deleted, the trash purged, a figure that went down or a
// usage record gone never give spend back; nothing but the triggers writes it.
// Over 200 lines: one script over one token's spend; split, each part would rebuild it.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import trashRowsMod from '../../server/src/services/trash-rows'
import trashSheetsMod from '../../server/src/services/trash-sheets'
import purgeMod from '../../server/src/services/trash-purge'
import columnMod from '../../server/src/services/column-delete'
import undoMod from '../../server/src/services/run-undo'
import spendMod from '../../server/src/services/token-spend'
import libMod from '../../server/src/lib/token-spend'
import callsMod from '../../server/src/services/usage-calls'
import actorMod from '../../server/src/lib/actor'
const { deleteRowsToTrash } = trashRowsMod as typeof import('../../server/src/services/trash-rows')
const { trashSheet } = trashSheetsMod as typeof import('../../server/src/services/trash-sheets')
const { purgeTrashItems } = purgeMod as typeof import('../../server/src/services/trash-purge')
const { deleteSheetColumn } = columnMod as typeof import('../../server/src/services/column-delete')
const { undoRun } = undoMod as typeof import('../../server/src/services/run-undo')
const { readTokenSpend, rowCostOf, spendCapRefusal, setTokenSpendCap, tokenSpendViews } =
  spendMod as typeof import('../../server/src/services/token-spend')
const { capReached, capToolNote, parseSpendCap, spendView } =
  libMod as typeof import('../../server/src/lib/token-spend')
const { addCall, noSpend, recordCallUsage } = callsMod as typeof import('../../server/src/services/usage-calls')
const { runAs, CUBEX } = actorMod as typeof import('../../server/src/lib/actor')

const { db, uid, tid, ok, done, idle, sheet, run } = undoKit('token-spend')

const token = (capUsd: number | null) => {
  const id = uuid()
  db.prepare(`INSERT INTO access_tokens (id, user_id, name, token_hash, token_prefix, scopes, spend_cap_micro)
    VALUES (?,?,?,?,?,?,?)`).run(id, uid, `Agent ${id.slice(0, 6)}`, `h-${id}`, 'cubex_pat_x', 'read,run',
    capUsd === null ? null : Math.round(capUsd * 1e6))
  return id
}
const spentOf = (t: string) => readTokenSpend(uid, t)!.spentUsd
const sumOfUsage = (t: string) => db.prepare(`SELECT IFNULL(SUM(ai_cost_usd + provider_cost_usd), 0)
  + IFNULL(SUM(enrich_micro), 0) / 1e6 FROM run_usage WHERE access_token_id = ?`).pluck().get(t) as number
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9
// A run made for `t` as a start under that token makes it (lib/actor.ts): the run and its usage record carry it.
const tagged = (kind: 'ai' | 'http', runId: string, t: string) => {
  db.prepare(`UPDATE ${kind === 'ai' ? 'ai_runs' : 'http_runs'} SET access_token_id = ? WHERE id = ?`).run(t, runId)
  db.prepare('UPDATE run_usage SET access_token_id = ? WHERE run_id = ?').run(t, runId)
}
const billRow = (runId: string, i: number, cost: number, provider: number | null = null) => db.prepare(
  `INSERT INTO ai_results (id, run_id, user_id, row_index, input_values, output_value, status, cost_usd,
    provider_cost_usd) VALUES (?,?,?,?,'{}','x','completed',?,?)`).run(uuid(), runId, uid, i, cost, provider)

await ok('the words: a cap, what is left, for life; a typed cap parses or says why', () => {
  assert.deepEqual(spendView(5_000_000, 1.25), { spend_cap_usd: 5, spent_usd: 1.25, left_usd: 3.75 })
  assert.deepEqual(spendView(null, 2), { spend_cap_usd: null, spent_usd: 2, left_usd: null })
  assert.deepEqual(spendView(1_000_000, 3), { spend_cap_usd: 1, spent_usd: 3, left_usd: 0 })
  assert.ok(capReached(1, 1) && capReached(1, 1.2) && !capReached(1, 0.99) && !capReached(null, 99))
  assert.deepEqual(parseSpendCap(''), { micro: null })
  assert.deepEqual(parseSpendCap(null), { micro: null })
  assert.deepEqual(parseSpendCap('12.5'), { micro: 12_500_000 })
  assert.deepEqual(parseSpendCap(0), { micro: 0 })
  for (const bad of [-1, 'ten', Infinity, 2_000_000, {}]) assert.ok('error' in parseSpendCap(bad), String(bad))
  assert.equal(capToolNote(spendView(null, 3), true), '')
  const full = capToolNote(spendView(20_000_000, 3), true)
  assert.match(full, /\$20\.00 in all/)
  assert.match(full, /\$17\.00 was left/)
  assert.match(full, /whole life, not per month/)
  assert.match(full, /in flight finish and count/)
  assert.doesNotMatch(capToolNote(spendView(20_000_000, 3), false), /in flight/)
})

await ok('a run inserted for a token carries it into its usage record; the app\'s runs carry none', () => {
  const t = token(10)
  const sid = sheet([{ A: '1' }], ['A', 'Out'])
  const ai = uuid(), http = uuid(), mine = uuid()
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status,access_token_id)
    VALUES (?,?,?,'Out','p','pending',?)`).run(ai, sid, uid, t)
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,access_token_id)
    VALUES (?,?,?,'{}','pending','Out',?)`).run(http, sid, uid, t)
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status)
    VALUES (?,?,?,'Out','p','pending')`).run(mine, sid, uid)
  const of = (id: string) => db.prepare('SELECT access_token_id FROM run_usage WHERE run_id = ?').pluck().get(id)
  assert.equal(of(ai), t)
  assert.equal(of(http), t)
  assert.equal(of(mine), null)
})

const t = token(0.4)
const sid = sheet([{ Name: 'a' }, { Name: 'b' }, { Name: 'c' }, { Name: 'd' }], ['Name', 'Out', 'Mail'])
let aiRun = ''

await ok('token_spend adds up what its runs spent, from the usage records', async () => {
  aiRun = await run(sid, 'ai', ['Out'], { 0: ['x'], 1: ['y'], 2: ['z'] })
  tagged('ai', aiRun, t)
  billRow(aiRun, 0, 0.1)
  billRow(aiRun, 1, 0.05, 0.02)                 // the user's own provider key billed too
  billRow(aiRun, 2, 0.000_000_4)                // under a micro-dollar still counts
  const enrich = await run(sid, 'http', ['Mail'], { 0: ['m@x.example'] })
  tagged('http', enrich, t)
  db.prepare('UPDATE http_runs SET spent_micro = 30000 WHERE id = ?').run(enrich)
  db.prepare('UPDATE http_runs SET spent_micro = 45000 WHERE id = ?').run(enrich)
  // A waterfall's AI steps (its usage record's mode is waterfall).
  const fall = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,access_token_id)
    VALUES (?,?,?,?,'running','Mail',?)`).run(fall, sid, uid, JSON.stringify({ waterfall: { steps: [] } }), t)
  db.prepare('UPDATE http_runs SET ai_cost_usd = 0.2, ai_provider_cost_usd = 0.01 WHERE id = ?').run(fall)
  // A preview and an AI helper done for the token (services/usage-calls.ts).
  const preview = noSpend()
  addCall(preview, { costUsd: 0.03 }, true)
  addCall(preview, { costUsd: 0.02, providerCostUsd: 0.01 }, true)
  runAs({ ...CUBEX, tokenId: t }, () => recordCallUsage(uid, sid, 'Out', 'preview', preview))
  const helper = noSpend()
  addCall(helper, { costUsd: 0.004 })
  runAs({ ...CUBEX, tokenId: t }, () => recordCallUsage(uid, sid, null, 'assist', helper))
  const expected = 0.1 + 0.05 + 0.02 + 0.000_000_4 + 0.045 + 0.2 + 0.01 + 0.03 + 0.02 + 0.01 + 0.004
  assert.ok(near(spentOf(t), expected), `${spentOf(t)} vs ${expected}`)
  assert.ok(near(spentOf(t), sumOfUsage(t)))
  const modes = db.prepare(`SELECT mode, cells FROM run_usage WHERE access_token_id = ? AND mode IN ('preview','assist')
    ORDER BY mode DESC`).all(t) as Array<{ mode: string; cells: number }>
  assert.deepEqual(modes, [{ mode: 'preview', cells: 2 }, { mode: 'assist', cells: 0 }])
  assert.ok(near(tokenSpendViews(uid).get(t)!.spent_usd, Math.round(expected * 1e6) / 1e6))
})

await ok('at the cap a start is refused with the cap, the spend and the lifetime note; a raise lifts it', () => {
  const msg = spendCapRefusal(uid, t)
  assert.ok(msg && msg.includes('$0.40 spend cap') && msg.includes('whole life, not a month'), msg ?? 'none')
  assert.equal(spendCapRefusal(uid, t, 'free'), null, 'a plain HTTP API run costs nothing here')
  assert.equal(spendCapRefusal(uid, null), null)
  assert.equal(spendCapRefusal(uid, token(null)), null)
  assert.equal(spendCapRefusal('someone-else', t), null, 'another account never reads this token')
  const view = setTokenSpendCap(uid, t, 2_000_000)!
  // Shown to the micro-dollar.
  assert.ok(view.spend_cap_usd === 2 && Math.abs(view.left_usd! - (2 - spentOf(t))) < 1e-6)
  assert.equal(spendCapRefusal(uid, t), null)
  assert.equal(setTokenSpendCap('someone-else', t, null), null)
  // Room left but less than one row's cap: a run with that per-row cap can't go on; an AI run can.
  setTokenSpendCap(uid, t, Math.round((spentOf(t) + 0.005) * 1e6))
  const noRoom = spendCapRefusal(uid, t, 0.01)
  assert.ok(noRoom?.includes('too little for another row at up to $0.01'), noRoom ?? 'none')
  assert.equal(spendCapRefusal(uid, t, null), null)
  assert.equal(spendCapRefusal(uid, t, 0), null, 'a row that costs nothing always fits')
  // A revoked token's cap can't be raised, and its message says what to do instead.
  const gone = token(0)
  db.prepare("UPDATE access_tokens SET revoked_at = datetime('now') WHERE id = ?").run(gone)
  assert.match(spendCapRefusal(uid, gone) ?? '', /was revoked, so its cap can't be raised/)
  assert.equal(setTokenSpendCap(uid, gone, 1_000_000), null)
  assert.equal(tokenSpendViews(uid).size, 3)   // live tokens only
})

await ok('what one more row costs, by run: AI unbounded, an enrichment its per-row cap, plain HTTP free', () => {
  const tool = { v: 1, maxCostPerRowUsd: 0.02 }
  const enrichment = JSON.stringify({ requestConfig: {}, responseMapping: [], enrichment: tool })
  assert.equal(rowCostOf('ai', null), null)
  assert.equal(rowCostOf('http', enrichment), 0.02)
  assert.equal(rowCostOf('http', JSON.stringify({ requestConfig: {}, responseMapping: [] })), 'free')
  assert.equal(rowCostOf('http', 'not json'), 'free')
  const fall = (most: number) => JSON.stringify({ requestConfig: {}, waterfall: { v: 1, maxCostPerRowUsd: most } })
  assert.equal(rowCostOf('http', fall(0.3)), 0.3)
  assert.equal(rowCostOf('http', fall(0)), null, 'a waterfall with no known price: what was billed stops it')
})

await ok('spend never goes down: undo, deleted rows, column and sheet, the trash purged, a lower figure', async () => {
  const before = spentOf(t)
  const undone = await undoRun(uid, 'ai', aiRun)
  assert.ok('ok' in undone, JSON.stringify(undone))
  await idle(sid)
  assert.equal(spentOf(t), before, 'undo')
  db.transaction(() => deleteRowsToTrash(sid, uid, 'grid', { indexes: [0, 1] }))()
  await idle(sid)
  assert.equal(spentOf(t), before, 'rows deleted')
  const col = await deleteSheetColumn(sid, uid, 'Out')
  assert.ok(!('fail' in col), JSON.stringify(col))
  await idle(sid)
  assert.equal(spentOf(t), before, 'column deleted')
  // A figure that went down (a run's counter rewritten lower) gives nothing back.
  db.prepare("UPDATE http_runs SET spent_micro = 0 WHERE sheet_id = ? AND master_column_name = 'Mail'").run(sid)
  db.prepare('UPDATE http_runs SET ai_cost_usd = 0, ai_provider_cost_usd = 0 WHERE sheet_id = ?').run(sid)
  assert.equal(spentOf(t), before, 'lower figures')
  sheet([{ Name: 'keep' }], ['Name'])        // the table keeps a sheet
  const gone = trashSheet(uid, tid, sid)
  assert.ok('ok' in gone, JSON.stringify(gone))
  purgeTrashItems(uid, [gone.ok.trashId])
  for (let i = 0; i < 300 && db.prepare('SELECT 1 FROM sheets WHERE id = ?').get(sid); i++) {
    await new Promise(r => setTimeout(r, 10))
  }
  assert.ok(!db.prepare('SELECT 1 FROM ai_runs WHERE sheet_id = ?').get(sid), 'the purge took its runs')
  assert.equal(spentOf(t), before, 'sheet purged')
  db.prepare('DELETE FROM run_usage WHERE access_token_id = ?').run(t)
  assert.equal(spentOf(t), before, 'usage records gone')
})

await ok('nothing but migration 042\'s triggers writes token_spend, and no code deletes or edits run_usage', () => {
  const root = path.resolve('server/src')
  const files: string[] = []
  const walk = (dir: string) => fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p)
  })
  walk(root)
  const writes = /\b(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+token_spend\b/i
  const usage = /\b(UPDATE|DELETE\s+FROM)\s+run_usage\b/i
  const bad = files.filter(f => writes.test(fs.readFileSync(f, 'utf8')) || usage.test(fs.readFileSync(f, 'utf8')))
  assert.deepEqual(bad, [])
  assert.ok(files.length > 100)
})

done()
