// An enrichment start sent again with its idempotency key answers what its first call started (replayed: true),
// whatever changed since: the key is read before the catalog, the webhook, the sheet and its rows. Its webhook
// deleted while treg's catalog can't be reached: the same call with no key is refused now; with its key, sent
// more times than the token's run-start window holds, it answers the first call each time, makes no run and takes
// no slot (a new start goes through after), and the same key with other arguments is still refused. A key from
// before the arguments as sent were kept (its parsed hash alone) still replays. Inputs nested 5,000 levels deep
// get the start's own 400, with a key or without, over the service and /api/v1. treg is the repo's mock.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { tregKit, type Args, type Start } from './token-replay-treg-kit'

const k = await tregKit('token-replay-first-enrich')
const { db, uid, ok, done, idle, TRIES, runsOn, replays, preUpgradeRow, hook, caller, fresh, tregDown } = k
const { clearCatalogCache } = await import('../../server/src/lib/treg-catalog')
const { deleteRunWebhook } = await import('../../server/src/services/run-hooks')
const { sentArgsHash } = await import('../../server/src/lib/run-idempotency')
const { tokenStartEnrichmentRun } = await import('../../server/src/services/enrich-token-run')
const { default: v1Enrich } = await import('../../server/src/routes/api-v1-enrich')

const app = express()
app.use(express.json())
app.use('/v1', (req, _res, next) => {
  Object.assign(req, { userId: uid, accessTokenId: 'tok-enrich-v1', tokenScopes: new Set(['read', 'write', 'run']) })
  next()
}, v1Enrich)
const server = app.listen(0)
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const start: Start = a => tokenStartEnrichmentRun(caller('tok-enrich'), a)
const email = (sid: string, more: Args = {}) => ({ sheet_id: sid, tool_id: 'treg.people.email.find',
  preset: 'verified_email', column_name: 'Work email', inputs: { full_name: 'Name', domain: 'Website' }, ...more })

await ok(`an enrichment retried with its key after its webhook was deleted and while treg's catalog can't be `
  + `reached answers the first start ${TRIES} times`, async () => {
  const sid = fresh()
  const args = email(sid, { webhook_id: await hook('enrich') })
  await replays(sid, start, args, 'enrich-K', {
    change: async () => {
      assert.equal(deleteRunWebhook(uid, args.webhook_id as string), true)
      await tregDown(true)
      clearCatalogCache()
    },
    now: { fail: 'upstream', message: "Can't reach treg's catalog right now. Try again in a moment." },
    other: { ...args, webhook_id: undefined, column_name: 'Other email', outputs: [{ field: 'email',
      column_name: 'Other' }] },
    settle: async () => { await tregDown(false) },
  })
})

await ok('a key from before the sent arguments were kept (the parsed hash alone) still replays an enrichment',
  async () => {
    const sid = fresh()
    const args = email(sid)
    const first = await start({ ...args, idempotency_key: 'enrich-legacy-new' })
    assert.ok('ok' in first && first.started, JSON.stringify(first))
    await idle(sid)
    preUpgradeRow('enrich-legacy-new', 'enrich-legacy-old', sentArgsHash('enrichment_run', args), 'enrichment_run')
    const runs = runsOn(sid)
    assert.deepEqual(await start({ ...args, idempotency_key: 'enrich-legacy-old' }),
      { ok: { ...first.ok, replayed: true }, started: false })
    assert.equal(runsOn(sid), runs, 'no second run')
  })

// 5,000 levels of { a: ... } as an input: the start's own refusal, with its key or without, and REST answers it
// (400), not a server error. REST's body is written out as a client sends it.
const LEVELS = 5000
let deep: unknown = 'x'
for (let i = 0; i < LEVELS; i++) deep = { a: deep }
const deepJson = `${'{"a":'.repeat(LEVELS)}"x"${'}'.repeat(LEVELS)}`
await ok('inputs nested 5,000 levels deep get the start\'s 400 with a key or without, over the service and REST',
  async () => {
    const sid = fresh()
    const args = email(sid, { inputs: { full_name: { value: deep }, domain: 'Website' } })
    const message = 'Input full_name needs a column or a value.'
    assert.deepEqual(await start(args), { fail: 'bad_request', message }, 'service, no key')
    assert.deepEqual(await start({ ...args, idempotency_key: 'deep-enrich' }), { fail: 'bad_request', message },
      'service, a key')
    for (const key of [null, 'deep-enrich-rest']) {
      const body = '{"tool_id":"treg.people.email.find","preset":"verified_email","column_name":"Work email",'
        + `${key ? `"idempotency_key":"${key}",` : ''}"inputs":{"full_name":{"value":${deepJson}},"domain":"Website"}}`
      const res = await fetch(`${base}/v1/sheets/${sid}/enrichment-runs`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body })
      assert.deepEqual({ status: res.status, body: await res.json() }, { status: 400, body: { error: message } },
        `rest, ${key ? 'a key' : 'no key'}`)
    }
    assert.equal(runsOn(sid), 0)
  })

server.close()
k.stop()
done()
