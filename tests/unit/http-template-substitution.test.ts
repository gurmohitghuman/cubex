// Regression test for P1-1: HTTP template token substitution.
//
// Guards the single-pass substitution in lib/http-request-template.ts against
// the two bugs the July-2026 review found in the old per-token global-replace:
//   1. prefix collision — /key rewriting inside /key2 (and swapping the wrong
//      saved API key when one key name is a prefix of another), and
//   2. path-segment corruption — a token's literal text inside an unrelated
//      URL path segment (/domain inside /domain-search) being rewritten.
// Plus the behavior-preserving edges: {{missing}} marker, unresolved /slash left
// untouched, empty {{  }} untouched, $$/$&/$' in values taken literally.
//
// Pure-function test — runs under tsx. It imports the real module, which
// transitively opens a DB connection at load (lib/db.ts), so the runner MUST set
// DB_PATH to a throwaway file (never cubex.db). See package.json "test:unit".
// The key-substitution branch (wrong-key hazard) is covered by the HTTP-run e2e
// spec, which exercises real api_keys rows; here we cover the column + missing +
// untouched paths where the two bugs actually lived.

import assert from 'node:assert/strict';
import httpRequestTemplate from '../../server/src/lib/http-request-template';

const { replaceTemplateVariables, withSheetColumns } = httpRequestTemplate;

if (!process.env.DB_PATH) {
  console.error('Refusing to run without DB_PATH set to a throwaway path (this module opens a DB on import).');
  process.exit(1);
}

let failures = 0;
function check(label: string, actual: string, expected: string) {
  try {
    assert.equal(actual, expected);
    console.log('ok  ', label);
  } catch {
    failures++;
    console.log('FAIL', label, '\n  got :', JSON.stringify(actual), '\n  want:', JSON.stringify(expected));
  }
}

const sub = (t: string, row: Record<string, string>) =>
  // allowSavedKeys=false → no api_keys lookup; isolates the substitution logic.
  replaceTemplateVariables(t, row, 'test-user', 'live', false);

// --- The two P1-1 bugs (must be fixed) ---
check('prefix-collision: /key must not rewrite /key2',
  sub('a=/key&b=/key2', { key: 'AAA', key2: 'BBB' }), 'a=AAA&b=BBB');
check('path-segment: /domain must not corrupt /domain-search',
  sub('https://api.hunter.io/v2/domain-search?domain=/domain&x=1', { domain: 'acme.com' }),
  'https://api.hunter.io/v2/domain-search?domain=acme.com&x=1');

// --- Behavior-preserving regression guards ---
check('brace value substitutes', sub('{{col}}', { col: 'X' }), 'X');
// A live request with an unresolved {{brace}} fails the row instead of sending
// "[MISSING: ...]"; the stored (redacted) record keeps the marker.
let liveErr = '';
try { sub('{{nope}}', {}); } catch (e) { liveErr = (e as Error).message; }
check('unresolved {{brace}} in a live request throws', liveErr.includes("doesn't match a column or a saved key") ? 'threw' : liveErr || 'did not throw', 'threw');
check('unresolved {{brace}} in the redacted record → [MISSING] marker',
  replaceTemplateVariables('{{nope}}', {}, 'test-user', 'redact-secrets', false), '[MISSING: {{nope}}]');
// A listed column the row has no value for is an empty cell, not a missing ref.
check('listed column absent from the row → empty', sub('id={{alt id}}&x=1', withSheetColumns({}, ['alt id'])), 'id=&x=1');
check('a present value still wins over the empty default', sub('{{alt}}', withSheetColumns({ alt: 'A1' }, ['alt'])), 'A1');
check('unresolved /slash left untouched', sub('/v1/users', {}), '/v1/users');
check('empty {{  }} left untouched (not [MISSING])', sub('{{  }}', {}), '{{  }}');
check('$$ / $& / $\' in cell value taken literally',
  sub('/tok', { tok: "a$$b$'c$&d" }), "a$$b$'c$&d");
check('normalized column name matches (company.domain → /company_domain)',
  sub('{{company.domain}}', { 'Company Domain': 'z' }), 'z');
check('non-string template coerces to empty',
  replaceTemplateVariables(undefined as unknown as string, {}, 'u', 'live', false), '');

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll http-template substitution assertions passed.');
