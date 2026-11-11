// An HTTP API start sent again with its idempotency key answers the run its first call started (replayed: true),
// whatever changed since: the key is read before anything that reads the sheet, saved keys or webhooks. A cURL
// command whose key save_keys named (its column exists now, its key is saved), the same with save_keys: true and
// the saved key deleted since (the start would save it again), and a plain URL whose webhook was deleted since;
// over the service, /api/v1 and MCP. Each retry, sent more times than the token's run-start window holds, makes no
// run, saves no key and takes no slot: a new start goes through after. The same key with other arguments is still
// refused. A key written before a start was also known by its arguments as sent (the parsed hash alone) still
// replays. What the hash leaves out never replays where the start refuses it (save_keys without curl, an empty
// webhook_id, curl with the url it became), and arguments nested too deep to hash get the start's own 400, with
// a key or without.
import assert from 'node:assert/strict'
import {
  httpKit, curlWith, CONFLICT, SURFACE_NAMES, TRIES, type Answer, type Args, type Surface,
} from './token-replay-http-kit'
import hooksMod from '../../server/src/services/run-hooks'
import ledgerMod from '../../server/src/lib/run-idempotency'
import argsMod from '../../server/src/services/http-token-args'
import curlMod from '../../server/src/services/curl-token'
const { createRunWebhook, deleteRunWebhook } = hooksMod as typeof import('../../server/src/services/run-hooks')
const { curlForToken } = curlMod as typeof import('../../server/src/services/curl-token')
const { writeRunLedger } = ledgerMod as typeof import('../../server/src/lib/run-idempotency')
const { httpSentHash } = argsMod as typeof import('../../server/src/services/http-token-args')
const k = await httpKit('token-replay-first-http')
const { db, uid, ok, done, idle, start, refusal, fresh, runsOn, keyNames, base, cookie } = k

// Starts `args` with `key`, changes the sheet with `change`, then retries it TRIES times: each answers the first
// start, replayed, with no run made and no key saved; then the first key with other arguments is refused as
// before, and a new key starts (the window is untouched).
async function replays(surface: Surface, args: Args, key: string,
  change: (first: Record<string, unknown>) => Promise<void> | void, refusedNow: (a: Args) => Promise<Answer>) {
  const first = await start(surface, { ...args, idempotency_key: key })
  assert.ok(first.ok && first.ok.run_id && first.status !== 200, `${surface}: ${JSON.stringify(first)}`)
  await idle(args.sheet_id)
  await change(first.ok)
  const now = await refusedNow(args)
  assert.ok(!now.ok, `${surface}: without its key the same start is refused now: ${JSON.stringify(now)}`)
  const runs = runsOn(args.sheet_id), keys = keyNames()
  const want = { ...first.ok, replayed: true, ...(first.status ? { status: 200 } : {}) }
  for (let i = 0; i < TRIES; i++) {
    const again = await start(surface, { ...args, idempotency_key: key })
    assert.deepEqual({ ...again.ok, ...(again.status ? { status: again.status } : {}) }, want,
      `${surface} try ${i}: ${JSON.stringify(again)}`)
  }
  assert.equal(runsOn(args.sheet_id), runs, `${surface}: no second run`)
  assert.deepEqual(keyNames(), keys, `${surface}: no key saved`)
  // Other columns and no webhook, so the sheet as it is now refuses neither.
  const elsewhere = (column: string) => ({ ...args, webhook_id: undefined, master_column_name: column,
    response_mapping: [{ json_path: '$.ok', column_name: `${column} got` }] })
  const other = await start(surface, { ...elsewhere('Other'), idempotency_key: key })
  assert.equal(other.message, CONFLICT, `${surface}: other arguments: ${JSON.stringify(other)}`)
  const next = await start(surface, { ...elsewhere('Next'), idempotency_key: `${key}-next` })
  assert.ok(next.ok && next.ok.run_id, `${surface}: a new start after the retries: ${JSON.stringify(next)}`)
}
const taken = (column: string) => `A column named "${column}" already exists. Choose a different name.`
const mapping = (column: string) => [{ json_path: '$.ok', column_name: column }]

for (const surface of SURFACE_NAMES) {
  await ok(`${surface}: a cURL start whose key save_keys named, retried once its column exists and its key is saved, `
    + `answers the first start ${TRIES} times`, async () => {
    const name = `named_${surface}`
    const args = { sheet_id: fresh(), curl: curlWith(`Named${surface}`), save_keys: { 'Authorization header': name },
      master_column_name: 'Find', response_mapping: mapping('Got') }
    await replays(surface, args, `curl-named-${surface}`, () => {
      assert.ok(keyNames().includes(name), 'the first start saved its key')
    }, async a => {
      const now = await start(surface, a)
      assert.equal(now.message, taken('Find'))
      return now
    })
  })

  await ok(`${surface}: a cURL start with save_keys: true, retried after its saved key was deleted, answers the first `
    + 'start and saves nothing', async () => {
    const args = { sheet_id: fresh(), curl: curlWith(`Gone${surface}`), save_keys: true,
      master_column_name: 'Find', response_mapping: mapping('Got') }
    await replays(surface, args, `curl-deleted-${surface}`, async first => {
      const [name] = first.saved_keys as string[]
      const id = db.prepare('SELECT id FROM api_keys WHERE user_id = ? AND name = ?').pluck().get(uid, name)
      const res = await fetch(`${base}/api/settings/api-keys/${id}`, { method: 'DELETE', headers: { cookie } })
      assert.equal(res.status, 200, 'the key the first start saved, deleted')
    }, async a => {
      const now = await start(surface, a)
      assert.equal(now.message, taken('Find'))
      return now
    })
  })

  await ok(`${surface}: a URL start whose webhook was deleted since answers the first start`, async () => {
    const hook = await createRunWebhook(uid, { url: `https://hook-${surface}.cubex-e2e.invalid/done` })
    assert.ok('ok' in hook, JSON.stringify(hook))
    const args = { sheet_id: fresh(), url: 'https://api.example.com/ask?n={{Name}}', webhook_id: hook.ok.webhook.id,
      master_column_name: 'Ask', response_mapping: mapping('Said') }
    await replays(surface, args, `url-hook-${surface}`, () => {
      assert.equal(deleteRunWebhook(uid, hook.ok.webhook.id), true)
    }, async a => {
      const now = await start(surface, { ...a, master_column_name: 'Ask 2' })
      assert.match(now.message ?? '', /^webhook_id doesn't match a run webhook\./)
      return now
    })
  })

  await ok(`${surface}: save_keys without curl, sent with a started key, gets the start's 400`, async () => {
    const args = { sheet_id: fresh(), url: 'https://api.example.com/ask?n={{Name}}', master_column_name: 'Ask',
      response_mapping: mapping('Said'), idempotency_key: `no-curl-${surface}` }
    assert.ok((await start(surface, args)).ok)
    for (const save_keys of [true, false, { 'Authorization header': 'x' }]) {
      assert.deepEqual(await start(surface, { ...args, save_keys }),
        refusal(surface, 'bad_request', 400, 'save_keys goes with curl.'), JSON.stringify(save_keys))
    }
  })
}

// MCP's schema refuses an empty webhook_id itself, so the service and REST say what the start says.
for (const surface of ['service', 'rest'] as const) {
  await ok(`${surface}: an empty webhook_id, sent with a started key, gets the start's 400`, async () => {
    const args = { sheet_id: fresh(), url: 'https://api.example.com/ask?n={{Name}}', master_column_name: 'Ask',
      response_mapping: mapping('Said'), idempotency_key: `hook-empty-${surface}` }
    assert.ok((await start(surface, args)).ok)
    for (const webhook_id of ['', '  ', 0, false]) {
      assert.deepEqual(await start(surface, { ...args, webhook_id }),
        refusal(surface, 'bad_request', 400, 'webhook_id must be the id of a run webhook.'), JSON.stringify(webhook_id))
    }
  })
}

// curl sent with the url, method and headers it became (the cURL command's own code builds them), and its key:
// the start's 400, never a replay of the cURL start.
for (const surface of SURFACE_NAMES) {
  await ok(`${surface}: curl with the url, method and headers it became, sent with its key, gets the start's 400`,
    async () => {
      const args = { sheet_id: fresh(), curl: curlWith(`Both${surface}`), save_keys: true, master_column_name: 'Find',
        response_mapping: mapping('Got'), idempotency_key: `curl-both-${surface}` }
      assert.ok((await start(surface, args)).ok)
      const built = curlForToken({ userId: uid, scopes: new Set(['secrets']) }, args.sheet_id, args.curl, true)
      assert.ok('ok' in built, JSON.stringify(built))
      const { url, method, headers, body } = built.ok.prepared.request
      assert.deepEqual(await start(surface, { ...args, url, method, headers, ...(body === undefined ? {} : { body }) }),
        refusal(surface, 'bad_request', 400, 'Pass either curl or url/method/headers/body, not both.'))
    })
}

await ok('a key from before the sent arguments were kept (the parsed hash alone) still replays a cURL start',
  async () => {
    const args = { sheet_id: fresh(), curl: curlWith('Legacy'), save_keys: true, master_column_name: 'Find',
      response_mapping: mapping('Got') }
    const first = await start('service', { ...args, idempotency_key: 'curl-legacy-new' })
    assert.ok(first.ok, JSON.stringify(first))
    await idle(args.sheet_id)
    const row = db.prepare(`SELECT request_hash, result_json FROM data_operation_ledger WHERE user_id = ?
      AND idempotency_key = 'curl-legacy-new'`).get(uid) as { request_hash: string; result_json: string }
    const parsed = row.request_hash.split(' ').filter(h => h !== httpSentHash(args))
    assert.equal(parsed.length, 1, 'a cURL start is known by two hashes')
    writeRunLedger(uid, 'curl-legacy-old', parsed[0], 'http_run', JSON.parse(row.result_json))
    const runs = runsOn(args.sheet_id)
    assert.deepEqual(await start('service', { ...args, idempotency_key: 'curl-legacy-old' }),
      { ok: { ...first.ok, replayed: true }, status: 200 })
    assert.equal(runsOn(args.sheet_id), runs, 'no second run')
  })

// 5,000 levels of { a: ... } in a request's headers: the start's own refusal, with its key or without, and REST
// answers it (400), not a server error. REST's body is written out as a client sends it.
const LEVELS = 5000
let deep: unknown = 'x'
for (let i = 0; i < LEVELS; i++) deep = { a: deep }
const deepJson = `${'{"a":'.repeat(LEVELS)}"x"${'}'.repeat(LEVELS)}`
await ok('headers nested 5,000 levels deep get the start\'s 400 with a key or without, over the service and REST',
  async () => {
    const sid = fresh()
    const args = { sheet_id: sid, url: 'https://api.example.com/ask', headers: { X: deep },
      master_column_name: 'Deep', response_mapping: mapping('Deep got') }
    const message = 'headers must be an object of strings'
    assert.deepEqual(await start('service', args), { fail: 'bad_request', message }, 'service, no key')
    assert.deepEqual(await start('service', { ...args, idempotency_key: 'deep-service' }),
      { fail: 'bad_request', message }, 'service, a key')
    for (const key of [null, 'deep-rest']) {
      const body = `{"url":"https://api.example.com/ask","master_column_name":"Deep",`
        + `"response_mapping":[{"json_path":"$.ok","column_name":"Deep got"}],`
        + `${key ? `"idempotency_key":"${key}",` : ''}"headers":{"X":${deepJson}}}`
      const res = await fetch(`${base}/v1/sheets/${sid}/http-runs`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body })
      assert.deepEqual({ status: res.status, body: await res.json() }, { status: 400, body: { error: message } },
        `rest, ${key ? 'a key' : 'no key'}`)
    }
    assert.equal(runsOn(sid), 0)
  })

k.close()
done()
