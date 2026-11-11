// A replay answers only a token the start would accept for its scopes. An HTTP API start one token of the account
// made with an idempotency key, sent again with that key by a token with read, write and run but not 'secrets':
// a cURL command with a key in it (save_keys true, or naming the key) and a URL whose header names a saved key
// get the start's own 403, in its words, with the key as without it, every time and with no run made (so do a
// $NAME naming a saved key, and -u with a user and password); the token with 'secrets' still gets the replay.
// Whether a cURL command needs 'secrets' is read from the command alone: one without a key, started by a token
// without the scope, replays for it after its sheet went to the trash or a {{column}} it names was removed.
// Over the service, /api/v1 and MCP. The queue only records.
import assert from 'node:assert/strict'
import { httpKit, curlWith, SURFACE_NAMES, TRIES, type Args, type Surface } from './token-replay-http-kit'
import keysMod from '../../server/src/services/saved-keys'
import trashMod from '../../server/src/services/trash-sheets'
import lifecycleMod from '../../server/src/services/run-lifecycle'
import deleteMod from '../../server/src/services/column-delete'
const { createSavedKey } = keysMod as typeof import('../../server/src/services/saved-keys')
const { trashSheet } = trashMod as typeof import('../../server/src/services/trash-sheets')
const { cancelRun } = lifecycleMod as typeof import('../../server/src/services/run-lifecycle')
const { deleteSheetColumn } = deleteMod as typeof import('../../server/src/services/column-delete')
const k = await httpKit('token-replay-scopes-http')
const { uid, tid, ok, done, idle, start, refusal, fresh, runsOn, sheet } = k
const mapping = [{ json_path: '$.ok', column_name: 'Got' }]

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

  await ok(`${surface}: a $NAME naming a saved key, and -u with a user and password, retried with their keys by a `
    + "token without 'secrets', get the start's 403", async () => {
    const name = `scope_var_${surface}`
    assert.ok('ok' in createSavedKey(uid, { name, key_type: 'bearer', key_value: `var-key-${surface}-0123456789`,
      description: null }))
    const variable = ['$', name].join('')
    await scoped(surface, { sheet_id: fresh(), curl: `curl 'https://api.example.com/find?n={{Name}}' `
      + `-H "X-Key: ${variable}"`, master_column_name: 'Find', response_mapping: mapping },
    `scope-var-${surface}`, configScope(name))
    await scoped(surface, { sheet_id: fresh(), curl: `curl -u ada:pw-${surface}-0123456789 `
      + "'https://api.example.com/find?n={{Name}}'", save_keys: true, master_column_name: 'Find',
    response_mapping: mapping }, `scope-basic-${surface}`,
    "This cURL command has keys in it (-u user and password). Saving or using them needs the token's 'secrets' "
      + 'scope.')
  })
}

// A cURL command without a key, started by the token without 'secrets' with `key`, then `change`: without the key
// the start refuses as `now` says; with it, the first answer, every time, no run made.
async function keyless(surface: Surface, args: Args, key: string, change: (runId: string) => Promise<void>,
  now: { fail: string; status: number; message: string }) {
  const first = await start(surface, { ...args, idempotency_key: key }, { secrets: false })
  assert.ok(first.ok && first.ok.run_id, `${surface}: ${JSON.stringify(first)}`)
  await idle(args.sheet_id)
  await change(first.ok.run_id as string)
  assert.deepEqual(await start(surface, args, { secrets: false }), refusal(surface, now.fail, now.status, now.message),
    `${surface}: no key`)
  const runs = runsOn(args.sheet_id)
  const want = { ...first.ok, replayed: true, ...(first.status ? { status: 200 } : {}) }
  for (let i = 0; i < TRIES; i++) {
    const again = await start(surface, { ...args, idempotency_key: key }, { secrets: false })
    assert.deepEqual({ ...again.ok, ...(again.status ? { status: again.status } : {}) }, want,
      `${surface} try ${i}: ${JSON.stringify(again)}`)
  }
  assert.equal(runsOn(args.sheet_id), runs, `${surface}: no second run`)
}

for (const surface of SURFACE_NAMES) {
  await ok(`${surface}: a cURL start without a key, retried with its key by a token without 'secrets' after its `
    + 'sheet went to the trash, answers the first start', async () => {
    const sid = fresh()
    await keyless(surface, { sheet_id: sid, curl: "curl 'https://api.example.com/find?n={{Name}}'",
      master_column_name: 'Find', response_mapping: mapping }, `keyless-trash-${surface}`, async () => {
      const trashed = trashSheet(uid, tid, sid)
      assert.ok(!('error' in trashed), JSON.stringify(trashed))
    }, { fail: 'not_found', status: 404, message: 'Sheet not found' })
  })

  await ok(`${surface}: a cURL start whose Authorization reads a {{column}}, retried with its key by a token `
    + "without 'secrets' after that column was removed, answers the first start", async () => {
    const sid = sheet([{ Name: 'ada', Tok: 't-1' }, { Name: 'bob', Tok: 't-2' }], ['Name', 'Tok'])
    await keyless(surface, { sheet_id: sid, curl: "curl 'https://api.example.com/find?n={{Name}}' "
      + "-H 'Authorization: Bearer {{Tok}}'", master_column_name: 'Find', response_mapping: mapping },
    `keyless-column-${surface}`, async runId => {
      assert.deepEqual(await cancelRun('http', runId, uid), { ok: true })
      await idle(sid)
      assert.deepEqual(await deleteSheetColumn(sid, uid, 'Tok'), { ok: true })
      await idle(sid)
    }, { fail: 'bad_request', status: 400, message: 'The Authorization header needs a key ({{Tok}}), and no saved '
      + 'key or column has that name. Ask the user to save the key in Cubex (Settings, External service keys) as '
      + 'Tok, or put the key in the command and pass save_keys: true.' })
  })
}

k.close()
done()
