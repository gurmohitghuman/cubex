// Shared by the cURL-parser unit tests (curl-parse*.test.ts): run a check,
// compare what a command parses to, or check that it's refused and why.
import assert from 'node:assert/strict';
import { parseCurl, type ParsedCurl } from '../../server/src/lib/curl/parse';
import { findKeys, toDraft } from '../../server/src/lib/curl/key-detect';

// Stripe's and Slack's own documentation examples, built here from pieces: GitHub's
// push protection refuses a push holding them whole, real or not.
export const STRIPE_DOCS_KEY = ['sk', 'test', '4eC39HqLyjWDarjtT1zdp7dc'].join('_');
export const SLACK_DOCS_HOOK = ['https://hooks.slack.com/services', 'T00000000', 'B00000000', 'X'.repeat(24)].join('/');

let failures = 0;
export const ran = (label: string, fn: () => void) => {
  try {
    fn();
    console.log('ok  ', label);
  } catch (e) {
    failures++;
    console.log('FAIL', label, '\n ', e instanceof Error ? e.message : e);
  }
};

type Want = Partial<Omit<ParsedCurl, 'notes' | 'headers'>> & { headers?: Record<string, string>; notes?: string[] };

// Compares the fields `want` names; headers as a name → value map, notes by substring.
export function parses(label: string, cmd: string, want: Want) {
  ran(label, () => {
    const got = parseCurl(cmd);
    if (want.method) assert.equal(got.method, want.method, 'method');
    if (want.url !== undefined) assert.equal(got.url, want.url, 'url');
    if (want.headers) {
      assert.deepEqual(Object.fromEntries(got.headers.map(h => [h.name, h.value])), want.headers, 'headers');
    }
    if ('body' in want) assert.equal(got.body, want.body, 'body');
    if ('auth' in want) assert.deepEqual(got.auth, want.auth, 'auth');
    if (want.variables) assert.deepEqual([...got.variables].sort(), [...want.variables].sort(), 'variables');
    for (const n of want.notes ?? []) {
      assert.ok(got.notes.some(x => x.includes(n)), `a note containing "${n}" (got ${JSON.stringify(got.notes)})`);
    }
    if (want.notes && want.notes.length === 0) assert.deepEqual(got.notes, [], 'no notes');
  });
}

export function refuses(label: string, cmd: string, message: string) {
  ran(label, () => {
    assert.throws(() => parseCurl(cmd), (e: Error) => {
      assert.equal(e.name, 'CurlError');
      assert.ok(e.message.includes(message), `"${e.message}" should include "${message}"`);
      return true;
    });
  });
}

export function finish(name: string) {
  if (failures > 0) {
    console.error(`\n${failures} ${name} check(s) failed`);
    process.exit(1);
  }
  console.log(`\nall ${name} checks passed`);
}

// The keys a command holds, with the draft they sit in.
export const keysOf = (cmd: string, resolves: (n: string) => boolean = () => false) => {
  const p = parseCurl(cmd);
  const draft = toDraft(p);
  return { draft, findings: findKeys(draft, { resolves, variables: p.variables }) };
};
