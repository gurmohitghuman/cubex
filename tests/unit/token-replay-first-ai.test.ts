// An AI run start sent again with its idempotency key answers the run its first call started (replayed: true),
// even once OpenRouter's model list no longer has its model: the key is read before the model check (and before
// the sheet and the webhook). Started while the list couldn't be read (so the model wasn't checked), then asked
// again with the list answering without that model: the same start with no key is refused for the model; with
// its key, sent more times than the token's run-start window holds, it answers the first start each time, makes
// no run and takes no slot (a new start goes through after). The same key with other arguments is still refused.
// The stand-in for OpenRouter is ai-spend-kit.ts's; the job queue only records.
import assert from 'node:assert/strict'
import { startStandIn, world, PRICED } from './ai-spend-kit'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const stand = await startStandIn()
const w = await world()
const { db, uid, ok, sheetOf } = w
const { tokenStartAiRun } = await import('../../server/src/services/run-start-token')
const { sheetBusyWith } = await import('../../server/src/lib/sheet-busy')
const { MCP_RUN_STARTS_PER_MIN } = await import('../../server/src/lib/api-v1-constants')
const idle = async (sid: string) => { while (sheetBusyWith(sid)) await new Promise(r => setTimeout(r, 5)) }
const runsOn = (sid: string) => db.prepare('SELECT COUNT(*) FROM ai_runs WHERE sheet_id = ?').pluck().get(sid)
const TRIES = MCP_RUN_STARTS_PER_MIN + 1
const GONE = 'OpenRouter doesn\'t offer the model "test/gone": it was retired or renamed, or the name is mistyped. '
  + 'Use list_models (MCP) or GET /api/v1/models?search= to find the exact id.'

await ok(`an AI start retried with its key after its model left the list answers the first start ${TRIES} times`,
  async () => {
    const c = { userId: uid, tokenId: 'tok-ai', scopes: new Set(['read', 'write', 'run']) }
    const sid = sheetOf(2)
    const args = { sheet_id: sid, column_name: 'Hi', prompt: 'Say hi to /name', model: 'test/gone' }
    stand.models = 'fail'
    const first = await tokenStartAiRun(c, { ...args, idempotency_key: 'ai-gone' })
    assert.ok('ok' in first && first.started, JSON.stringify(first))
    await idle(sid)
    stand.models = 'ok'
    assert.deepEqual(await tokenStartAiRun(c, args), { fail: 'bad_request', message: GONE }, 'no key: refused now')
    assert.equal(runsOn(sid), 1)
    for (let i = 0; i < TRIES; i++) {
      assert.deepEqual(await tokenStartAiRun(c, { ...args, idempotency_key: 'ai-gone' }),
        { ok: { ...first.ok, replayed: true }, started: false }, `try ${i}`)
    }
    assert.equal(runsOn(sid), 1, 'no second run')
    const other = { ...args, column_name: 'Other', model: PRICED, idempotency_key: 'ai-gone' }
    assert.deepEqual(await tokenStartAiRun(c, other),
      { fail: 'conflict', message: 'Idempotency key was already used with different arguments.' })
    const next = await tokenStartAiRun(c, { ...other, idempotency_key: 'ai-next' })
    assert.ok('ok' in next && next.started, `a new start after the retries: ${JSON.stringify(next)}`)
  })

stand.close()
w.done()
process.exit(0)
