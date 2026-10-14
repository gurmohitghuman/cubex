// "Paste a cURL command": finding the keys in a command (lib/curl/key-detect.ts)
// and building a column's request from it (lib/curl/key-apply.ts). The rule under
// test: a pasted key never reaches the request a column stores. Every key needs
// a choice (save, use a saved key, leave out), and anything else is refused.
// Pure: no DB.
import assert from 'node:assert/strict';
import { parseCurl } from '../../server/src/lib/curl/parse';
import { findKeys, toDraft, type KeyFinding } from '../../server/src/lib/curl/key-detect';
import { maskKey } from '../../server/src/lib/curl/key-rules';
import { applyKeyChoices, suggestKeyNames, type KeyChoice } from '../../server/src/lib/curl/key-apply';
import { STRIPE_DOCS_KEY, finish, keysOf, ran } from './curl-test-kit';

const none = { resolves: () => false, variables: [] as string[] };
const brief = (f: KeyFinding) => ({ id: f.id, where: f.where, kind: f.kind });
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

ran('a $VARIABLE in Authorization needs a key, unless a saved key has that name', () => {
  const cmd = 'curl https://api.openai.com/v1/responses -H "Authorization: Bearer $OPENAI_API_KEY" -d \'{}\'';
  const { findings } = keysOf(cmd);
  assert.equal(findings.length, 1);
  assert.deepEqual(brief(findings[0]), { id: 'header:0', where: 'Authorization header', kind: 'missing' });
  assert.equal(findings[0].placeholder, '$OPENAI_API_KEY');
  assert.equal(findings[0].refName, 'OPENAI_API_KEY');
  assert.equal(findings[0].secret, undefined);
  assert.deepEqual(keysOf(cmd, n => n === 'OPENAI_API_KEY').findings, []);
});

ran('Chrome copy: a Bearer token and a cookie', () => {
  const { findings } = keysOf(
    "curl 'https://app.example.com/api/me' -H 'authorization: Bearer abc.def.ghi' -b 'sid=123; theme=dark'",
  );
  assert.deepEqual(findings.map(brief), [
    { id: 'header:0', where: 'authorization header', kind: 'value' },
    { id: 'header:1', where: 'Cookie header', kind: 'value' },
  ]);
  assert.equal(findings[0].secret, 'abc.def.ghi');
  assert.equal(findings[0].start, 'Bearer '.length);
  assert.equal(findings[1].cookie, true);
});

ran('-u key: is Basic sign-in held as base64(user:password)', () => {
  const { findings } = keysOf(`curl https://api.stripe.com/v1/customers -u "${STRIPE_DOCS_KEY}:"`);
  assert.deepEqual(findings.map(brief), [{ id: 'auth', where: '-u user and password', kind: 'value' }]);
  assert.equal(findings[0].secret, b64(`${STRIPE_DOCS_KEY}:`));
  assert.equal(findings[0].basic, true);
});

ran('-u with $VARIABLES needs a key (base64 can\'t hold a reference)', () => {
  const { findings } = keysOf('curl https://api.twilio.com/x -u $TWILIO_API_KEY:$TWILIO_API_SECRET', () => true);
  assert.deepEqual(findings.map(brief), [{ id: 'auth', where: '-u user and password', kind: 'missing' }]);
});

ran('docs placeholders need a key: <YOUR-TOKEN>, YOUR_API_KEY, xxx', () => {
  for (const v of ['<YOUR-TOKEN>', 'YOUR_API_KEY', 'xxx', 'API_KEY_HERE', '{api_key}', '[TOKEN]']) {
    const { findings } = keysOf(`curl https://api.github.com/user -H "Authorization: Bearer ${v}"`);
    assert.equal(findings[0]?.kind, 'missing', v);
    assert.equal(findings[0].placeholder, v);
  }
  assert.equal(keysOf('curl https://e.com -H "X-API-Key: MyS3cr3tK3y99"').findings[0].kind, 'value');
});

ran('key-like header names are keys; ordinary ones are not', () => {
  for (const h of ['X-API-Key', 'Api-Key', 'X-Auth-Token', 'Private-Token', 'X-RapidAPI-Key',
    'Ocp-Apim-Subscription-Key', 'X-Treg-Token', 'X-Shopify-Access-Token', 'DD-API-KEY', 'X-Client-Secret', 'X-Session-Token']) {
    assert.equal(keysOf(`curl https://e.com -H "${h}: abcdef123456"`).findings.length, 1, h);
  }
  for (const h of ['Content-Type', 'Accept', 'User-Agent', 'X-Request-Id', 'Idempotency-Key', 'X-GitHub-Api-Version',
    'Origin', 'Referer', 'Accept-Language', 'Cache-Control']) {
    assert.equal(keysOf(`curl https://e.com -H "${h}: abcdef123456"`).findings.length, 0, h);
  }
});

ran('query parameters: api_key always, key only when long', () => {
  assert.deepEqual(keysOf("curl 'https://e.com/x?q=a&api_key=abc123'").findings.map(brief),
    [{ id: 'query:1', where: 'api_key in the URL', kind: 'value' }]);
  assert.deepEqual(keysOf("curl 'https://e.com/x?key=status'").findings, []);
  const google = "curl 'https://maps.example.com/x?key=AIzaSyA1234567890abcdefghijklmnopqrstu'";
  assert.equal(keysOf(google).findings.length, 1);
  assert.equal(keysOf("curl 'https://e.com/x?appid=YOUR_API_KEY'").findings[0].kind, 'missing');
});

ran('body fields: JSON and form', () => {
  const json = keysOf('curl https://e.com -d \'{"api_key":"xyz12345","name":"bob","max_tokens":5}\'');
  assert.deepEqual(json.findings.map(brief), [{ id: 'body:12', where: 'api_key in the body', kind: 'value' }]);
  assert.equal(json.draft.body!.slice(json.findings[0].start, json.findings[0].end), 'xyz12345');
  const form = keysOf("curl https://e.com -d 'x=1&token=abc12345'");
  assert.deepEqual(form.findings.map(brief), [{ id: 'body:10', where: 'token in the body', kind: 'value' }]);
});

ran('known key formats anywhere: the URL path, a body string', () => {
  const k = 'sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA';
  assert.deepEqual(keysOf(`curl https://hooks.example.com/${k}/x`).findings.map(brief),
    [{ id: 'url@26', where: 'the URL', kind: 'value' }]);
  const body = keysOf(`curl https://e.com -d '{"note":"use ${k} here"}'`).findings;
  assert.equal(body[0].secret, k);
  assert.equal(body[0].canDrop, false);
});

ran('two keys with the same label get numbered', () => {
  const { findings } = keysOf('curl https://e.com -d \'{"token":"aaaaaaaa1","x":{"token":"bbbbbbbb2"}}\'');
  assert.deepEqual(findings.map(f => f.where), ['token in the body', 'token in the body (2)']);
});

ran('applying choices: save, use, leave out', () => {
  const { draft, findings } = keysOf(
    "curl 'https://api.example.com/v1/x?api_key=q12345678' -H 'X-API-Key: t0ken12345' -b 'sid=1' -u bob:pw",
  );
  assert.deepEqual(findings.map(f => f.id), ['header:0', 'header:1', 'auth', 'query:0']);
  const built = applyKeyChoices(draft, findings, {
    'header:0': { save: 'example' }, 'header:1': { drop: true }, auth: { use: 'example_basic' },
    'query:0': { save: 'example_q' },
  });
  assert.equal(built.url, 'https://api.example.com/v1/x?api_key={{example_q}}');
  assert.deepEqual(built.headers, { 'X-API-Key': '{{example}}', Authorization: 'Basic {{example_basic}}' });
});

ran('-u is ignored when Authorization is set (curl), so only the header is a key', () => {
  const { findings } = keysOf("curl https://e.com -H 'Authorization: Bearer t0ken12345' -u bob:pw");
  assert.deepEqual(findings.map(f => f.id), ['header:0']);
});

ran('a body key is swapped in place', () => {
  const { draft, findings } = keysOf('curl https://e.com -d \'{"api_key":"xyz12345","name":"bob"}\'');
  const built = applyKeyChoices(draft, findings, { [findings[0].id]: { save: 'acme' } });
  assert.equal(built.body, '{"api_key":"{{acme}}","name":"bob"}');
  assert.equal(built.headers['Content-Type'], 'application/json');
});

ran('a bare "Authorization: Bearer" keeps its scheme', () => {
  const { draft, findings } = keysOf("curl https://e.com -H 'Authorization: Bearer'");
  assert.equal(findings[0].kind, 'missing');
  const built = applyKeyChoices(draft, findings, { 'header:0': { save: 'k' } });
  assert.deepEqual(built.headers, { Authorization: 'Bearer {{k}}' });
});

ran('no choice, no request', () => {
  const { draft, findings } = keysOf("curl https://e.com -H 'X-API-Key: abcdef123456'");
  assert.throws(() => applyKeyChoices(draft, findings, {}), /Choose what to do with the key in the X-API-Key header/);
  assert.throws(() => applyKeyChoices(draft, [], {}), /Choose what to do/, 'the final scan catches a skipped finding');
});

ran('a body key can\'t be left out; a key name must be letters, numbers, _ and -', () => {
  const { draft, findings } = keysOf('curl https://e.com -d \'{"api_key":"xyz12345"}\'');
  assert.throws(() => applyKeyChoices(draft, findings, { [findings[0].id]: { drop: true } }), /can't be left out/);
  assert.throws(() => applyKeyChoices(draft, findings, { [findings[0].id]: { save: 'my key' } }),
    /can't be a key name/);
});

ran('a reference that differs from a saved key only in case is rewritten to its exact name', () => {
  const { draft, findings } = keysOf("curl https://e.com -H 'Authorization: Bearer {{openai_api_key}}'", () => true);
  const choices: Record<string, KeyChoice> = {};
  const canonical = (n: string) => (n === 'openai_api_key' ? 'OPENAI_API_KEY' : null);
  const built = applyKeyChoices(draft, findings, choices, canonical);
  assert.equal(built.headers.Authorization, 'Bearer {{OPENAI_API_KEY}}');
});

ran('no keys: the request comes through unchanged', () => {
  const { draft, findings } = keysOf("curl 'https://e.com/x?q=1&pretty' -H 'Accept: application/json'", () => true);
  assert.deepEqual(findings, []);
  assert.deepEqual(applyKeyChoices(draft, findings, {}), {
    method: 'GET', url: 'https://e.com/x?q=1&pretty', headers: { Accept: 'application/json' },
  });
});

ran('suggested names come from the host, skip taken ones, keep a $NAME', () => {
  const one = keysOf("curl https://api.openai.com/v1/x -H 'Authorization: Bearer t0ken12345'");
  assert.deepEqual(suggestKeyNames(one.draft.base, one.findings, () => false), ['openai']);
  assert.deepEqual(suggestKeyNames(one.draft.base, one.findings, n => n === 'openai'), ['openai_2']);
  const two = keysOf("curl https://api.example.co.uk/x -H 'Authorization: Bearer t0ken12345' -b 'sid=1'");
  assert.deepEqual(suggestKeyNames(two.draft.base, two.findings, () => false), ['example', 'example_cookie']);
  const pair = keysOf("curl https://api.example.com/x -H 'X-API-Key: k1234567890' -H 'X-Secret: s1234567890'");
  assert.deepEqual(suggestKeyNames(pair.draft.base, pair.findings, () => false), ['example_x_api_key', 'example_x_secret']);
  const v = keysOf('curl https://api.openai.com/v1/x -H "Authorization: Bearer $OPENAI_API_KEY"');
  assert.deepEqual(suggestKeyNames(v.draft.base, v.findings, () => false), ['OPENAI_API_KEY']);
  const ip = keysOf("curl http://10.0.0.1/x -H 'X-API-Key: abcdef123456'");
  assert.deepEqual(suggestKeyNames(ip.draft.base, ip.findings, () => false), ['api']);
});

ran('masked hints show little', () => {
  assert.equal(maskKey('sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX'), 'sk-p…UVWX');
  assert.equal(maskKey('abcdefghijklmn'), 'abc…');
  assert.equal(maskKey('short'), '•••');
});

ran('a resolving {{reference}} in a key spot is fine as it is', () => {
  assert.deepEqual(findKeys(toDraft(parseCurl("curl https://e.com -H 'X-API-Key: {{apollo}}'")), {
    ...none, resolves: n => n === 'apollo',
  }), []);
});

finish('curl-keys');
