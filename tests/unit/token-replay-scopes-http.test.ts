// A replay answers only a token the start would accept for its scopes. An HTTP API start one token of the account
// made with an idempotency key, sent again with that key by a token with read, write and run but not 'secrets':
// a cURL command with a key in it (save_keys true, or naming the key) and a URL whose header names a saved key
// get the start's own 403, in its words, with the key as without it, every time and with no run made; the
// token with 'secrets' still gets the replay. Over the service, /api/v1 and MCP. The queue only records.
import assert from 'node:assert/strict'
import { httpKit, curlWith, SURFACE_NAMES, TRIES, type Args } from './token-replay-http-kit'
import keysMod from '../../server/src/services/saved-keys'
const { createSavedKey } = keysMod as typeof import('../../server/src/services/saved-keys')
const k = await httpKit('token-replay-scopes-http')
const { ok, done, idle, start, refusal, fresh, runsOn } = k

const CURL_SCOPE = "This cURL command has keys in it (Authorization header). Saving or using them needs the token's "
  + "'secrets' scope."
const configScope = (key: string) => `This config references saved API key(s): ${key}. The access token needs the `
  + "'secrets' scope (in addition to 'run')."

// The token with 'secrets' starts `args` with `key`; the one without gets `message` (403) without the key and
// with it, TRIES times, no run made; the token with 'secrets' then gets the replay.
async function scoped(surface: typeof SURFACE_NAMES[number], args: Args, key: string, message: string) {
  const first = await start(surface, { ...args, idempotency_key: key })
  assert.ok(first.ok && first.ok.run_id, `${surface}: ${JSON.stringify(first)}`)
  await idle(args.sheet_id)
  const runs = runsOn(args.sheet_id)
  const want = refusal(surface, 'forbidden', 403, message)
  assert.deepEqual(await start(surface, args, { secrets: false }), want, `${surface}: no key`)
  for (let i = 0; i < TRIES; i++) {
    assert.deepEqual(await start(surface, { ...args, idempotency_key: key }, { secrets: false }), want,
      `${surface}: the key, try ${i}`)
  }
  assert.equal(runsOn(args.sheet_id), runs, `${surface}: no run made`)
  const again = await start(surface, { ...args, idempotency_key: key })
  assert.deepEqual(again.ok, { ...first.ok, replayed: true }, `${surface}: the token with 'secrets' replays`)
}

for (const surface of SURFACE_NAMES) {
  await ok(`${surface}: a cURL start with a key in it and save_keys: true, retried with its key by a token without `
    + "'secrets', gets the start's 403", async () => {
    await scoped(surface, { sheet_id: fresh(), curl: curlWith(`ScopeTrue${surface}`), save_keys: true,
      master_column_name: 'Find', response_mapping: [{ json_path: '$.ok', column_name: 'Got' }] },
    `scope-curl-${surface}`, CURL_SCOPE)
  })

  await ok(`${surface}: a cURL start whose save_keys names its key, retried with its key by a token without `
    + "'secrets', gets the start's 403", async () => {
    await scoped(surface, { sheet_id: fresh(), curl: curlWith(`ScopeNamed${surface}`),
      save_keys: { 'Authorization header': `scope_named_${surface}` }, master_column_name: 'Find',
      response_mapping: [{ json_path: '$.ok', column_name: 'Got' }] }, `scope-named-${surface}`, CURL_SCOPE)
  })

  await ok(`${surface}: a URL start whose header names a saved key, retried with its key by a token without `
    + "'secrets', gets the start's 403", async () => {
    const name = `scope_saved_${surface}`
    const saved = createSavedKey(k.uid, { name, key_type: 'bearer', key_value: `saved-key-${surface}-0123456789`,
      description: null })
    assert.ok('ok' in saved, JSON.stringify(saved))
    await scoped(surface, { sheet_id: fresh(), url: 'https://api.example.com/ask?n={{Name}}',
      headers: { Authorization: `Bearer {{${name}}}` }, master_column_name: 'Ask',
      response_mapping: [{ json_path: '$.ok', column_name: 'Said' }] }, `scope-saved-${surface}`, configScope(name))
  })
}

k.close()
done()
