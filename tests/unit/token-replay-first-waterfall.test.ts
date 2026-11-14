// A waterfall start (and a dry run) sent again with its idempotency key answers what its first call started
// (replayed: true), whatever changed since: the key is read before the webhook, the sheet and its rows. Its
// webhook deleted, a dry run's row deleted: the same call with no key is refused now; with its key, sent more
// times than the token's run-start window holds, it answers the first call each time (a dry run: its whole trace,
// read again), makes no run and takes no slot, and the same key with other arguments is still refused. A dry run
// whose sheet went to the trash replays its trace from there. A key from before the arguments as sent were kept
// (its parsed hash alone) still replays. Only estimate_only false or left out is a start: another value gets the
// start's 400 with a key too. A replay answers only a token the start would accept for its scopes: a run whose
// HTTP step reads a saved key gets a token without 'secrets' the start's 403. treg is the repo's mock; the job
// queue only records, so nothing is called (a dry run is marked done here once it is made).
import assert from 'node:assert/strict'
import { tregKit, sleep, type Args, type Result, type Start } from './token-replay-treg-kit'

const k = await tregKit('token-replay-first-waterfall')
const { db, uid, tid, ok, done, TRIES, runsOn, replays, preUpgradeRow, hook, caller, fresh } = k
const { deleteRunWebhook } = await import('../../server/src/services/run-hooks')
const { deleteRowsByIds } = await import('../../server/src/services/rows-write')
const { trashSheet } = await import('../../server/src/services/trash-sheets')
const { createSavedKey } = await import('../../server/src/services/saved-keys')
const { sentArgsHash } = await import('../../server/src/lib/run-idempotency')
const { tokenWaterfall } = await import('../../server/src/services/waterfall-token-run')
const { dryRunJson } = await import('../../server/src/services/waterfall-token-dry')
const { readDryRun } = await import('../../server/src/services/waterfall-dry-read')

const STEPS = [
  { kind: 'http', label: 'Own API', url: 'https://api.example.com/find?d={{domain}}', value_path: '$.email' },
]
const waterfall = (sid: string, more: Args = {}) => ({ sheet_id: sid, column_name: 'Found', result_type: 'email',
  inputs: { domain: 'Website' }, steps: STEPS, ...more })
const by = (tokenId: string, secrets = false): Start =>
  a => tokenWaterfall(caller(tokenId, secrets), a, { estimateDefault: true }) as Promise<Result>
// A dry run's answer waits for it to end: marked done here once it is made (the queue only records).
const dryBy = (sid: string, tokenId: string, secrets = false): Start => async a => {
  const before = runsOn(sid)
  let answered = false
  const answer = by(tokenId, secrets)(a).finally(() => { answered = true })
  while (!answered && runsOn(sid) === before) await sleep(10)
  db.prepare("UPDATE http_runs SET status = 'completed' WHERE sheet_id = ? AND status != 'completed'").run(sid)
  return answer
}
const HOOK_GONE = "webhook_id doesn't match a run webhook. "
  + 'List them with list_run_webhooks or GET /api/v1/run-webhooks.'
const firstRowOf = (sid: string) => db.prepare('SELECT id FROM rows WHERE sheet_id = ? ORDER BY row_index')
  .pluck().get(sid) as string

await ok(`a waterfall retried with its key after its webhook was deleted answers the first start ${TRIES} times`,
  async () => {
    const sid = fresh()
    const args = waterfall(sid, { webhook_id: await hook('waterfall'), estimate_only: false })
    await replays(sid, by('tok-waterfall'), args, 'waterfall-K', {
      change: () => { assert.equal(deleteRunWebhook(uid, args.webhook_id as string), true) },
      now: { fail: 'bad_request', message: HOOK_GONE }, other: { ...args, webhook_id: undefined, column_name: 'Other' },
    })
  })

await ok('estimate_only "maybe", null, 0 or "FALSE" with a started key gets the start\'s 400', async () => {
  const sid = fresh()
  const start = by('tok-estimate')
  const args = waterfall(sid, { estimate_only: false, idempotency_key: 'waterfall-estimate' })
  assert.ok('ok' in await start(args))
  for (const estimate_only of ['maybe', null, 0, 'FALSE']) {
    assert.deepEqual(await start({ ...args, estimate_only }),
      { fail: 'bad_request', message: 'estimate_only must be true or false' }, JSON.stringify(estimate_only))
  }
})

await ok('a key from before the sent arguments were kept (the parsed hash alone) still replays a waterfall',
  async () => {
    const sid = fresh()
    const start = by('tok-legacy')
    const args = waterfall(sid, { estimate_only: false })
    const first = await start({ ...args, idempotency_key: 'waterfall-legacy-new' })
    assert.ok('ok' in first && first.started, JSON.stringify(first))
    preUpgradeRow('waterfall-legacy-new', 'waterfall-legacy-old', sentArgsHash('waterfall_run', args, ['action']),
      'waterfall_run')
    const runs = runsOn(sid)
    assert.deepEqual(await start({ ...args, idempotency_key: 'waterfall-legacy-old' }),
      { ok: { ...first.ok, replayed: true }, started: false, changed: first.changed })
    assert.equal(runsOn(sid), runs, 'no second run')
  })

await ok(`a dry run retried with its key after its row was deleted answers its whole trace, read again, ${TRIES} `
  + 'times', async () => {
  const sid = fresh()
  const rowId = firstRowOf(sid)
  const args = waterfall(sid, { dry_run: true, target_row_ids: [rowId] })
  // The trace as it reads now: the deleted row is gone from it.
  const traceNow = (first: Args): Result => {
    const view = readDryRun(uid, first.run_id as string)
    assert.ok(view && view.rows.some(r => r.gone), 'the deleted row reads as gone')
    return { ok: { ...dryRunJson(view), replayed: true }, started: false }
  }
  await replays(sid, dryBy(sid, 'tok-dry'), args, 'dry-K', {
    change: () => {
      const out = deleteRowsByIds(sid, uid, [rowId])
      assert.ok(!('fail' in out), JSON.stringify(out))
    },
    now: { fail: 'bad_request', message: `Unknown row id(s): ${rowId}` },
    other: waterfall(sid, { dry_run: true, column_name: 'Other' }), want: traceNow, conflict: 'bad_request',
  })
})

await ok('a dry run retried with its key after its sheet went to the trash answers its trace from there', async () => {
  const sid = fresh()
  const start = dryBy(sid, 'tok-dry-trash')
  const args = waterfall(sid, { dry_run: true, target_row_ids: [firstRowOf(sid)] })
  const first = await start({ ...args, idempotency_key: 'dry-trash' })
  assert.ok('ok' in first && first.started, JSON.stringify(first))
  const trashed = trashSheet(uid, tid, sid)
  assert.ok(!('error' in trashed), JSON.stringify(trashed))
  assert.deepEqual(await start(args), { fail: 'not_found', message: 'Sheet not found' }, 'no key')
  for (let i = 0; i < TRIES; i++) {
    assert.deepEqual(await start({ ...args, idempotency_key: 'dry-trash' }),
      { ok: { ...first.ok, replayed: true }, started: false }, `try ${i}`)
  }
  assert.equal(runsOn(sid), 1, 'no second dry run')
})

const keyed = (sid: string, name: string, more: Args) => waterfall(sid, { steps: [{ ...STEPS[0],
  headers: { Authorization: `Bearer /${name}` } }], ...more })
const stepScope = (name: string) => `An HTTP step reads the saved key /${name}: this needs the 'secrets' scope.`
for (const dry of [false, true]) {
  const what = dry ? 'a dry run' : 'a waterfall'
  await ok(`${what} whose HTTP step reads a saved key, retried with its key by a token without 'secrets', gets the `
    + 'start\'s 403; the token with it replays', async () => {
    const sid = fresh()
    const name = `wf_key_${dry ? 'dry' : 'run'}`
    assert.ok('ok' in createSavedKey(uid, { name, key_type: 'bearer', key_value: `wf-secret-${name}-0123456789`,
      description: null }))
    const args = keyed(sid, name, dry ? { dry_run: true, target_row_ids: [firstRowOf(sid)] } : { estimate_only: false })
    const key = `wf-scope-${dry ? 'dry' : 'run'}`
    const [withSecrets, without] = dry
      ? [dryBy(sid, 'tok-wf-secrets', true), dryBy(sid, 'tok-wf-run')]
      : [by('tok-wf-secrets', true), by('tok-wf-run')]
    const first = await withSecrets({ ...args, idempotency_key: key })
    assert.ok('ok' in first && first.started, JSON.stringify(first))
    const runs = runsOn(sid)
    for (let i = 0; i < TRIES; i++) {
      assert.deepEqual(await without({ ...args, idempotency_key: key }),
        { fail: 'forbidden', message: stepScope(name) }, `try ${i}`)
    }
    assert.equal(runsOn(sid), runs, 'no run made')
    const again = await withSecrets({ ...args, idempotency_key: key })
    assert.ok('ok' in again && again.ok.replayed === true && again.ok.run_id === first.ok.run_id, JSON.stringify(again))
  })
}

k.stop()
done()
