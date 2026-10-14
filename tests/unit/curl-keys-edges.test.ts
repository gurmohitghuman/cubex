// "Paste a cURL command": the hard cases of finding keys (lib/curl/key-detect.ts,
// key-rules.ts), from the review: a cap on keys per command, a {{reference}}
// glued to text that could be a key, more key names, webhook URLs whose path is
// the secret, several keys in one field, a key as a bare query parameter.
// Pure: no DB. The everyday cases: curl-keys.test.ts.
import assert from 'node:assert/strict';
import { applyKeyChoices } from '../../server/src/lib/curl/key-apply';
import { SLACK_DOCS_HOOK, finish, keysOf, ran } from './curl-test-kit';

ran('more than 20 keys is refused before any naming or matching', () => {
  const cmd = `curl 'https://api.x.com/?${Array.from({ length: 21 }, (_, i) => `token=a${i}`).join('&')}'`
  assert.throws(() => keysOf(cmd), /more than 20 keys/);
  const t = Date.now();
  assert.throws(() => keysOf(`curl 'https://api.x.com/?${'token=a&'.repeat(3000)}'`), /more than 20 keys/);
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`);
});

ran('a {{reference}} next to text that could be a key is refused, never stored', () => {
  for (const h of ['Authorization: Bearer {{Domain}} sk-proj-REALKEY1234567890123456', 'X-Api-Key: {{PREFIX}}abcdefSECRET1234']) {
    assert.throws(() => keysOf(`curl https://e.com -H '${h}'`, () => true), /mixes a \{\{reference\}\}/, h);
  }
  assert.throws(() => keysOf("curl 'https://e.com/?api_key={{Domain}}ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'", () => true),
    /mixes a \{\{reference\}\}/);
  assert.deepEqual(keysOf("curl https://e.com -H 'X-Api-Key: {{Domain}}-prod'", () => true).findings, []);
});

ran('more key names: application_key, user_key, secret_key, CB-ACCESS-KEY, X-Honeycomb-Team, a nested Authorization', () => {
  const q = keysOf("curl 'https://api.datadoghq.com/x?application_key=0123456789abcdef0123456789abcdef01234567&user_key=abcdef1234567890xyz&secret_key=abc'");
  assert.deepEqual(q.findings.map(f => f.where), ['application_key in the URL', 'user_key in the URL', 'secret_key in the URL']);
  for (const h of ['CB-ACCESS-KEY', 'CB-ACCESS-PASSPHRASE', 'X-Honeycomb-Team']) {
    assert.equal(keysOf(`curl https://e.com -H '${h}: abcdef123456'`).findings.length, 1, h);
  }
  const nested = keysOf('curl https://e.com -d \'{"headers":{"Authorization":"Bearer xyz12345"}}\'')
  assert.deepEqual(nested.findings.map(f => f.where), ['Authorization in the body']);
  for (const p of ['sort_key=created_at_descending_order', 'idempotency_key=550e8400-e29b-41d4-a716-446655440000', 'key=status']) {
    assert.deepEqual(keysOf(`curl 'https://e.com/?${p}'`).findings, [], p);
  }
});

ran('webhook URLs whose path is the secret: Slack, Discord, Telegram', () => {
  const slack = keysOf(`curl -X POST ${SLACK_DOCS_HOOK} -d '{}'`);
  assert.equal(slack.findings.length, 1);
  const built = applyKeyChoices(slack.draft, slack.findings, { [slack.findings[0].id]: { save: 'slack' } });
  assert.equal(built.url, 'https://hooks.slack.com/services/{{slack}}');
  assert.equal(keysOf('curl https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJ').findings.length, 1);
  assert.equal(keysOf('curl https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getMe').findings.length, 1);
});

ran('two key formats in one header: two findings, both swapped', () => {
  const a = 'sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA'
  const b = 'ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
  const { draft, findings } = keysOf(`curl https://e.com -H 'X-Keys: ${a} ${b}'`);
  assert.equal(findings.length, 2);
  const built = applyKeyChoices(draft, findings, { [findings[0].id]: { save: 'k1' }, [findings[1].id]: { save: 'k2' } });
  assert.equal(built.headers['X-Keys'], '{{k1}} {{k2}}');
});

ran('a key as a bare query parameter (?sk-...) is found and swapped', () => {
  const { draft, findings } = keysOf("curl 'https://e.com/x?sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA&a=1'");
  assert.equal(findings.length, 1);
  assert.equal(applyKeyChoices(draft, findings, { [findings[0].id]: { save: 'k' } }).url, 'https://e.com/x?{{k}}&a=1');
});

ran('fields that only sound like keys are not keys: cursors, token counts and types, callbacks', () => {
  for (const q of ['pageToken=CAUQAA', 'next_token=b26v89c19zqg8o3fo7', 'token_type_hint=access_token',
    'oauth_callback=https://example.com/callback']) {
    assert.deepEqual(keysOf(`curl 'https://e.com/x?${q}'`).findings, [], q);
  }
  for (const body of ['{"max_tokens":"256"}', '{"monkey":"a long banana value here"}']) {
    assert.deepEqual(keysOf(`curl https://e.com -d '${body}'`).findings, [], body);
  }
});

ran('references next to ordinary text are fine (no key-like text beside them)', () => {
  for (const h of ['Authorization: Token token={{Token}}, email={{Email}}', 'Cookie: session={{Session}}; theme=dark; lang=en']) {
    assert.deepEqual(keysOf(`curl https://e.com -H '${h}'`, () => true).findings, [], h);
  }
});

finish('curl-keys-edges');
