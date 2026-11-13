// Why a run paused itself, as the sheet's notice shows it: the server's words for a run (services/
// run-pause-words.ts: the saved words; a run at its access token's spend cap worked out from the token as it is
// now, the same words get_run_status gives) and the client's lines from the run lists (client/src/lib/
// paused-runs.ts: which runs get one, which offer Open instead of Resume, the first few and how many more).
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import wordsMod from '../../server/src/services/run-pause-words'
import statusMod from '../../server/src/services/run-status'
import { firstLines, moreText, pausedLines } from '../../client/src/lib/paused-runs'
import type { AIRun, HTTPRun } from '../../client/src/utils/api'
const { pauseWords, withPauseWords, tokenCapWords } =
  wordsMod as typeof import('../../server/src/services/run-pause-words')
const { aiRunSummaryFromRow } = statusMod as typeof import('../../server/src/services/run-status')

const { db, uid, ok, done } = undoKit('paused-runs')
const token = (capUsd: number) => {
  const id = uuid()
  db.prepare(`INSERT INTO access_tokens (id, user_id, name, token_hash, token_prefix, scopes, spend_cap_micro)
    VALUES (?,?,?,?,?,?,?)`).run(id, uid, 'Night agent', `h-${id}`, 'cubex_pat_x', 'read,run', Math.round(capUsd * 1e6))
  return id
}
const paused = (over: Record<string, unknown>) => ({ status: 'paused', pause_reason: null, error_message: null,
  user_id: uid, access_token_id: null, ...over })

await ok('a run that paused itself has its saved words; a person\'s pause and other runs have none', () => {
  const words = 'Results couldn\'t be saved (disk full), so the run stopped sending calls. Free some disk space.'
  assert.equal(pauseWords(paused({ pause_reason: 'storage', error_message: words })), words)
  assert.equal(pauseWords(paused({})), null)
  assert.equal(pauseWords(paused({ error_message: 'left from before' })), null)
  assert.equal(pauseWords({ status: 'running', pause_reason: 'storage', error_message: words }), null)
  assert.equal(pauseWords(paused({ pause_reason: 'web_engine' })), null)
  // Markup stays as it came: the client shows it as text.
  assert.equal(pauseWords(paused({ pause_reason: 'provider_errors', error_message: '<b>x</b>' })), '<b>x</b>')
})

await ok("token_cap with no words: the token's cap as it is now, the same words get_run_status gives", () => {
  const t = token(0)
  const r = paused({ pause_reason: 'token_cap', access_token_id: t })
  assert.match(pauseWords(r)!, /^The access token "Night agent" reached its \$0\.00 spend cap \(\$0\.00 spent\)\./)
  const summary = aiRunSummaryFromRow({ ...r, id: 'r1', sheet_id: 's1', column_name: 'Hi (Output)' })
  assert.equal(summary.pause_message, pauseWords(r))
  db.prepare('UPDATE access_tokens SET spend_cap_micro = 1000000 WHERE id = ?').run(t)
  assert.equal(pauseWords(r), "Its access token's spend cap was raised: resume the run to go on.")
  assert.equal(tokenCapWords(uid, t), pauseWords(r))
  // An enrichment at its token's cap saved its own words: those are kept.
  assert.equal(pauseWords({ ...r, error_message: 'saved' }), 'saved')
})

await ok('the run list adds pause_message only to runs that paused themselves', () => {
  const list = withPauseWords([paused({ id: 'a', pause_reason: 'stalled', error_message: 'Resume it.' }),
    { id: 'b', status: 'running' }])
  assert.deepEqual(list.map(r => r.pause_message), ['Resume it.', undefined])
  assert.equal('pause_message' in list[1], false)
})

const ai = (over: Partial<AIRun>) => ({ id: 'ai1', column_name: 'Hi (Output)', status: 'paused', ...over }) as AIRun
const http = (config: unknown, over: Partial<HTTPRun>) => ({ id: 'h1', master_column_name: 'Call', status: 'paused',
  config: JSON.stringify(config), ...over }) as HTTPRun
const ENRICH = { enrichment: { v: 1 } }
const WATERFALL = { waterfall: { steps: [] } }

await ok('a line per run that paused itself, AI and HTTP alike; Open only where the drawer holds the raise', () => {
  const lines = pausedLines(
    [ai({ pause_reason: 'spend_limit', pause_message: 'At its limit.' }), ai({ id: 'ai2', pause_message: undefined }),
      ai({ id: 'ai3', status: 'running', pause_message: 'old' })],
    [http({ url: 'x' }, { pause_reason: 'provider_errors', pause_message: 'Kept failing.' }),
      http(ENRICH, { id: 'e1', master_column_name: 'Find email', pause_reason: 'spend_limit', pause_message: 'L' }),
      http(ENRICH, { id: 'e2', pause_reason: 'daily_limit', pause_message: 'D' }),
      http(ENRICH, { id: 'e3', pause_reason: 'balance', pause_message: 'B' }),
      http(WATERFALL, { id: 'w1', pause_reason: 'spend_limit', pause_message: 'W' }),
      http(WATERFALL, { id: 'w2', pause_reason: 'daily_limit', pause_message: 'WD' }),
      http('not json', { id: 'x1', config: 'not json', pause_reason: 'stalled', pause_message: 'S' })],
  )
  assert.deepEqual(lines.map(l => [l.runId, l.kind, l.action]), [
    ['ai1', 'ai', 'resume'], ['h1', 'http', 'resume'], ['e1', 'enrichment', 'open'], ['e2', 'enrichment', 'open'],
    ['e3', 'enrichment', 'resume'], ['w1', 'waterfall', 'open'], ['w2', 'waterfall', 'resume'],
    ['x1', 'http', 'resume'],
  ])
  assert.deepEqual(lines[0], { runId: 'ai1', kind: 'ai', column: 'Hi (Output)', reason: 'spend_limit',
    words: 'At its limit.', action: 'resume' })
  assert.equal(lines[2].column, 'Find email')
})

await ok('the notice lists the first three, then how many more', () => {
  const lines = pausedLines(['a', 'b', 'c', 'd', 'e'].map(id => ai({ id, pause_message: id })), [])
  const { shown, more } = firstLines(lines, 3)
  assert.deepEqual(shown.map(l => l.runId), ['a', 'b', 'c'])
  assert.equal(more, 2)
  assert.equal(moreText(2), 'And 2 more paused runs.')
  assert.equal(moreText(1), 'And 1 more paused run.')
  assert.equal(firstLines(lines.slice(0, 2), 3).more, 0)
})

done()
