// Regression test for P2-6: withToolErrors — the MCP tool-handler error wrapper.
//
// An UNEXPECTED throw in a tool handler must NOT reach the MCP SDK (which would
// return error.message verbatim to the PAT holder — SQL text, jobs.db paths,
// library internals). withToolErrors catches it, logs a redacted detail
// server-side, and returns a generic isError result. Deliberate err(...) returns
// (validation/scope) are normal return values and must pass through untouched.
//
// Pure function — runs under tsx with a throwaway DB_PATH (tool-helpers imports
// redact + access-token whose graph opens a DB).

import assert from 'node:assert/strict'
import toolHelpers from '../../server/src/mcp/tool-helpers'

const { withToolErrors, ok, err } = toolHelpers

if (!process.env.DB_PATH) {
  console.error('Refusing to run without a throwaway DB_PATH set.')
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

// Capture console.error so we can assert the throw is logged AND redacted.
const logged: string[] = []
const origError = console.error
console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')) }

async function main() {
  // 1. A throw with a secret in the message → generic result, secret NOT in the
  //    client-facing text, detail logged + redacted.
  const throwing = withToolErrors(async () => {
    throw new Error('boom sk-or-v1-deadbeefdeadbeefdeadbeefdeadbeef at /var/jobs.db')
  })
  const r1 = await throwing()
  check('throw → isError:true', r1.isError === true)
  const text1 = r1.content.map(c => c.text).join('')
  check('throw → client text is generic (no raw message)', !text1.includes('boom') && !text1.includes('jobs.db'))
  check('throw → client text has no sk- secret', !text1.includes('sk-or-v1-'))
  check('throw → detail was logged', logged.some(l => l.includes('MCP tool error')))
  check('throw → logged detail is redacted (no raw sk- key)', !logged.join('\n').includes('sk-or-v1-deadbeef'))

  // 2. A handler returning a deliberate err(...) → passes through unchanged.
  const denied = withToolErrors(async () => err("This action requires the 'run' scope on your Cubex access token."))
  const r2 = await denied()
  check('deliberate err() passes through (isError)', r2.isError === true)
  check('deliberate err() keeps its exact message', r2.content.map(c => c.text).join('').includes("'run' scope"))

  // 3. A normal ok(...) result → passes through unchanged.
  const good = withToolErrors(async () => ok({ hello: 'world' }))
  const r3 = await good()
  check('ok() passes through', !r3.isError && r3.content.map(c => c.text).join('').includes('world'))

  // 4. A non-Error throw (string) → still generic, still logged.
  const throwStr = withToolErrors(async () => { throw 'raw string failure' })
  const r4 = await throwStr()
  check('non-Error throw → isError generic', r4.isError === true && !r4.content.map(c => c.text).join('').includes('raw string failure'))
}

main().then(() => {
  console.error = origError
  if (failures > 0) { origError(`\n${failures} assertion(s) failed.`); process.exit(1) }
  console.log('\nAll mcp-tool-errors assertions passed.')
}).catch((e) => { console.error = origError; origError(e); process.exit(1) })
