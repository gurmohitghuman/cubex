// The OpenAPI document of /api/v1 (server/src/openapi/) lists every route
// once. Pins: each route on the real v1 router (its sub-routers, the run
// webhooks and the flag-gated transfer router included) has exactly one entry
// with the same method and path, and every entry is a real route; an entry's
// scope is the one the route's scope check asks for; every {param} has a path
// parameter; operationIds are unique; every entry has a one-line summary;
// every body, form, query and header schema converts to JSON Schema; and the
// document serializes, lists GET /openapi.json itself and holds no $ref it
// can't resolve.
import assert from 'node:assert/strict'
import v1Mod from '../../server/src/routes/api-v1'
import transferMod from '../../server/src/routes/api-v1-transfer'
import registryMod from '../../server/src/openapi/registry'
import documentMod from '../../server/src/openapi/document'
import constMod from '../../server/src/lib/api-v1-constants'
const { default: v1Router } = v1Mod as unknown as typeof import('../../server/src/routes/api-v1')
const { default: transferRouter } = transferMod as unknown as typeof import('../../server/src/routes/api-v1-transfer')
const { apiV1Routes } = registryMod as typeof import('../../server/src/openapi/registry')
const { jsonSchema, openApiDocument } = documentMod as typeof import('../../server/src/openapi/document')
const { MCP_EFFICIENT_ROWS_ENABLED } = constMod as typeof import('../../server/src/lib/api-v1-constants')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

type Handler = (req: unknown, res: unknown, next: () => void) => unknown
interface Layer {
  route?: { path: unknown; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> }
  handle: Handler & { stack?: Layer[] }
  regexp?: { fast_slash?: boolean }
}
interface Found { key: string; scopeCheck: Handler }

// Every route under a router, as "METHOD /openapi/{style}" with its first handler (the scope check).
function walk(stack: Layer[], out: Found[] = []): Found[] {
  for (const layer of stack) {
    if (layer.route) {
      const { path, methods, stack: handlers } = layer.route
      assert.equal(typeof path, 'string', `a route path that isn't a string: ${String(path)}`)
      const openApiPath = (path as string).replace(/:([A-Za-z0-9_]+)/g, '{$1}')
      for (const [method, on] of Object.entries(methods)) {
        if (on) out.push({ key: `${method.toUpperCase()} ${openApiPath}`, scopeCheck: handlers[0].handle })
      }
    } else if (layer.handle.stack) {
      assert.ok(layer.regexp?.fast_slash, 'a sub-router mounted under a path: this walk would miss its prefix')
      walk(layer.handle.stack, out)
    }
  }
  return out
}

const dupes = (keys: string[]) => keys.filter((k, i) => keys.indexOf(k) !== i)

// The v1 router, plus the transfer router when the flag left it unmounted.
const transfer = walk((transferRouter as unknown as { stack: Layer[] }).stack)
const mounted = walk((v1Router as unknown as { stack: Layer[] }).stack)
assert.ok(transfer.length > 0, 'the transfer router has routes')
assert.equal(transfer.every(t => mounted.some(m => m.key === t.key)), MCP_EFFICIENT_ROWS_ENABLED,
  'the transfer router is mounted exactly when MCP_EFFICIENT_ROWS_ENABLED is on')
const routes = MCP_EFFICIENT_ROWS_ENABLED ? mounted : [...mounted, ...transfer]
assert.ok(routes.length > 90, `found ${routes.length} routes`)
assert.deepEqual(dupes(routes.map(r => r.key)), [], 'no route is registered twice')

const entries = apiV1Routes()
const entryKey = (e: { method: string; path: string }) => `${e.method.toUpperCase()} ${e.path}`
const keys = entries.map(entryKey)
assert.deepEqual(dupes(keys), [], 'no route has two entries')
assert.deepEqual(routes.map(r => r.key).filter(k => !keys.includes(k)), [], 'every route has an entry')
assert.deepEqual(keys.filter(k => !routes.some(r => r.key === k)), [], 'every entry is a real route')
assert.deepEqual(entries.filter(e => e.flag).map(entryKey).sort(), transfer.map(t => t.key).sort(),
  'the flag-gated entries are the transfer router\'s routes')
console.log(`ok   ${routes.length} routes on the v1 router, each with one entry, and no other entries`)

// The scope check lets the entry's scope through and refuses a token with every other scope.
const ALL = ['read', 'write', 'run', 'secrets']
function passes(check: Handler, scopes: string[]): boolean {
  let passed = false
  let status = 0
  const res = { status(code: number) { status = code; return res }, json() { return res }, set() { return res } }
  check({ tokenScopes: new Set(scopes), body: {}, params: {}, query: {} }, res, () => { passed = true })
  assert.ok(passed || status === 403, 'a scope check either passes or answers 403')
  return passed
}
for (const route of routes) {
  const entry = entries[keys.indexOf(route.key)]
  assert.ok(passes(route.scopeCheck, [entry.scope]), `${route.key} lets a ${entry.scope} token through`)
  assert.ok(!passes(route.scopeCheck, ALL.filter(s => s !== entry.scope)), `${route.key} needs ${entry.scope}`)
}
console.log('ok   every entry\'s scope is the one its route checks')

const ids = entries.map(e => e.operationId)
assert.deepEqual(dupes(ids), [], 'operationIds are unique')
for (const e of entries) {
  const key = entryKey(e)
  assert.match(e.operationId, /^[a-z][A-Za-z0-9]+$/, `${key} has a camelCase operationId`)
  assert.ok(e.summary.trim() && !e.summary.includes('\n'), `${key} has a one-line summary`)
  assert.ok(ALL.includes(e.scope), `${key} has a scope`)
  const named = [...e.path.matchAll(/\{([^}]+)\}/g)].map(m => m[1])
  assert.deepEqual(e.params.map(p => p.name), named, `${key} has a path parameter for each {param}`)
  for (const p of e.params) assert.ok(p.description, `${key} says what {${p.name}} is`)
  assert.ok(!(e.body && e.form), `${key} has one kind of body`)
  for (const schema of [e.body, e.form, e.query, e.headers]) if (schema) jsonSchema(schema)
}
console.log('ok   unique operationIds; summaries, scopes and path parameters; every schema converts')

const doc = openApiDocument()
assert.equal(openApiDocument(), doc, 'the document is built once and kept')
const text = JSON.stringify(doc)
const parsed = JSON.parse(text) as {
  openapi: string; info: { title: string; version: string }; paths: Record<string, Record<string, {
    operationId: string; parameters?: Array<{ name: string; in: string; required: boolean }>
  }>>
}
assert.equal(parsed.openapi, '3.1.0')
assert.deepEqual([parsed.info.title, parsed.info.version], ['Cubex REST API', 'v1'])
const listed = Object.entries(parsed.paths)
  .flatMap(([path, ops]) => Object.keys(ops).map(m => `${m.toUpperCase()} ${path}`))
const expected = entries.filter(e => !e.flag || MCP_EFFICIENT_ROWS_ENABLED).map(entryKey)
assert.deepEqual(listed.sort(), expected.sort(), 'the document lists every mounted route once')
assert.ok(parsed.paths['/openapi.json']?.get, 'the document lists GET /openapi.json')
for (const [path, ops] of Object.entries(parsed.paths)) {
  const named = [...path.matchAll(/\{([^}]+)\}/g)].map(m => m[1])
  for (const [method, operation] of Object.entries(ops)) {
    const inPath = (operation.parameters ?? []).filter(p => p.in === 'path')
    assert.deepEqual(inPath.map(p => p.name), named, `${method} ${path}: path parameters`)
    assert.ok(inPath.every(p => p.required), `${method} ${path}: path parameters are required`)
  }
}
assert.ok(!text.includes('"$defs"'), 'no schema leans on $defs (they would resolve against the document)')
for (const [, ref] of text.matchAll(/"\$ref":"([^"]+)"/g)) {
  const target = ref.slice(2).split('/').reduce<unknown>((at, part) => (at as Record<string, unknown>)?.[part], parsed)
  assert.ok(ref.startsWith('#/') && target, `${ref} resolves in the document`)
}
console.log(`ok   the document serializes (${Math.round(text.length / 1024)} KB, ${listed.length} operations)`)
console.log('\nAll openapi assertions passed.')
