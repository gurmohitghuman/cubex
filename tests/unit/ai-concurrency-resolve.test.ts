// resolveAiConcurrency precedence: explicit > sheet default > DEFAULT_AI_CONCURRENCY.
//
// Regression guard for the throughput bug: a 1,735-row run_ai_column measured
// ~0.45 rows/sec because every MCP/API-started run was pinned at the parse-layer
// default of 5 — sheets.default_ai_concurrency was written by the UI slider and
// displayed back, but NO run path ever read it. The report inferred "runs execute
// serially"; the dispatcher was in fact correctly concurrent (a semaphore in
// ai-runner-lifecycle.ts), just always handed 5.
//
// The subtle part, and why this test exists: "caller omitted concurrency" must
// stay distinguishable from "caller chose 5" all the way from parseRunRequest to
// the start service. A destructuring default (`concurrency = 5`) collapses those
// two cases and silently reinstates the bug with no type error.
import assert from 'node:assert';

process.env.DB_PATH = process.env.DB_PATH
  || `/tmp/cubex-unit-concurrency-${process.pid}.db`;

const { db } = await import('../../server/src/lib/db');
// The throwaway DB starts empty; migrations create `sheets`.
const { runMigrations } = await import('../../server/src/db/migrate');
runMigrations();
const { resolveAiConcurrency } = await import('../../server/src/lib/ai-model-resolve');
const { DEFAULT_AI_CONCURRENCY, MAX_AI_CONCURRENCY } = await import('../../server/src/lib/constants-ai');
const { parseRunRequest } = await import('../../server/src/routes/ai-run-parse');

const USER = 'u-concurrency-test';
const SHEET_DEFAULTED = 's-with-default';
const SHEET_BARE = 's-no-default';
const SHEET_NULL = 's-null-default';

function seed() {
  db.prepare('DELETE FROM sheets WHERE user_id = ?').run(USER);
  db.prepare('DELETE FROM tables WHERE user_id = ?').run(USER);
  db.prepare('DELETE FROM users WHERE id = ?').run(USER);
  // sheets -> tables -> users are FK-linked; seed the parents first.
  db.prepare(`INSERT INTO users (id, password_hash) VALUES (?, 'x')`).run(USER);
  db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?, ?, ?)')
    .run('t-x', USER, 'ConcurrencyTest');
  const ins = db.prepare(
    `INSERT INTO sheets (id, table_id, user_id, name, column_order, default_ai_concurrency)
     VALUES (?, 't-x', ?, ?, '[]', ?)`,
  );
  ins.run(SHEET_DEFAULTED, USER, 'WithDefault', 97);
  ins.run(SHEET_NULL, USER, 'NullDefault', null);
}

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`ok   ${name}`);
  } catch {
    failures++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

seed();

// --- precedence ---------------------------------------------------------
check('explicit wins over the sheet default',
  resolveAiConcurrency(25, SHEET_DEFAULTED, USER), 25);
check('sheet default used when the caller omits one',
  resolveAiConcurrency(undefined, SHEET_DEFAULTED, USER), 97);
check('DEFAULT_AI_CONCURRENCY when the sheet stores NULL',
  resolveAiConcurrency(undefined, SHEET_NULL, USER), DEFAULT_AI_CONCURRENCY);
check('DEFAULT_AI_CONCURRENCY when the sheet does not exist',
  resolveAiConcurrency(undefined, SHEET_BARE, USER), DEFAULT_AI_CONCURRENCY);

// An explicit 5 must be honored AS a choice, not confused with "unspecified".
check('explicit 5 is respected even when the sheet default is 97',
  resolveAiConcurrency(5, SHEET_DEFAULTED, USER), 5);

// --- another user's sheet must not leak its setting ---------------------
check('a different user id does not read this sheet default',
  resolveAiConcurrency(undefined, SHEET_DEFAULTED, 'someone-else'), DEFAULT_AI_CONCURRENCY);

// --- junk explicit values fall through to the sheet default -------------
for (const junk of [null, 'fast', NaN, Infinity, {}, []]) {
  check(`junk explicit ${JSON.stringify(junk) ?? String(junk)} falls back to the sheet default`,
    resolveAiConcurrency(junk, SHEET_DEFAULTED, USER), 97);
}

// --- parse layer keeps "unspecified" distinct ---------------------------
const base = { sheetId: 's', columnName: 'c', prompt: 'p' };
const omitted = parseRunRequest({ ...base });
check('parseRunRequest leaves an omitted concurrency undefined',
  omitted.ok === true ? omitted.safeConcurrency : 'parse-error', undefined);

const explicit = parseRunRequest({ ...base, concurrency: 40 });
check('parseRunRequest passes an explicit concurrency through',
  explicit.ok === true ? explicit.safeConcurrency : 'parse-error', 40);

const overCap = parseRunRequest({ ...base, concurrency: 10_000 });
check('parseRunRequest clamps above MAX_AI_CONCURRENCY',
  overCap.ok === true ? overCap.safeConcurrency : 'parse-error', MAX_AI_CONCURRENCY);

const underOne = parseRunRequest({ ...base, concurrency: 0 });
check('parseRunRequest clamps 0 up to 1',
  underOne.ok === true ? underOne.safeConcurrency : 'parse-error', 1);

const negative = parseRunRequest({ ...base, concurrency: -8 });
check('parseRunRequest clamps a negative up to 1',
  negative.ok === true ? negative.safeConcurrency : 'parse-error', 1);

const fractional = parseRunRequest({ ...base, concurrency: 12.9 });
check('parseRunRequest floors a fractional value',
  fractional.ok === true ? fractional.safeConcurrency : 'parse-error', 12);

const junkParse = parseRunRequest({ ...base, concurrency: 'fast' });
check('parseRunRequest treats a non-numeric concurrency as unspecified',
  junkParse.ok === true ? junkParse.safeConcurrency : 'parse-error', undefined);

db.prepare('DELETE FROM sheets WHERE user_id = ?').run(USER);
db.prepare('DELETE FROM tables WHERE user_id = ?').run(USER);
db.prepare('DELETE FROM users WHERE id = ?').run(USER);

if (failures > 0) {
  console.log(`\n${failures} ai-concurrency check(s) FAILED`);
  process.exit(1);
}
console.log('\nall ai-concurrency checks passed');
