// Every MCP tool carries a title and behaviour hints from one table
// (server/src/mcp/tool-annotations.ts): registerTool refuses a tool missing
// from it, and the table names no tool that doesn't exist. Read tools say
// read-only, the permanent deletes say destructive, and results carry
// structuredContent next to the text.
import assert from 'node:assert/strict'
import buildMod from '../../server/src/mcp/build-server'
import annMod from '../../server/src/mcp/tool-annotations'
import helpMod from '../../server/src/mcp/tool-helpers'
const { buildMcpServer } = buildMod as typeof import('../../server/src/mcp/build-server')
const { TOOL_ANNOTATIONS } = annMod as typeof import('../../server/src/mcp/tool-annotations')
const { ok } = helpMod as typeof import('../../server/src/mcp/tool-helpers')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const server = buildMcpServer({ userId: 'u', tokenId: 't', tokenName: 'n', scopes: new Set() })
const tools = (server as unknown as { _registeredTools: Record<string, { title?: string; annotations?: Record<string, unknown> }> })._registeredTools
const registered = Object.keys(tools)
// transfer_rows and transform_column register only with MCP_EFFICIENT_ROWS_ENABLED.
const optional = new Set(['transfer_rows', 'transform_column'])

assert.ok(registered.length >= 20, `found ${registered.length} tools`)
for (const name of registered) {
  assert.ok(tools[name].title, `${name} has a title`)
  assert.equal(typeof tools[name].annotations?.readOnlyHint, 'boolean', `${name} says whether it is read-only`)
}
for (const name of Object.keys(TOOL_ANNOTATIONS)) {
  assert.ok(registered.includes(name) || optional.has(name), `${name} in the table is a real tool`)
}
for (const name of ['list_tables', 'read_rows', 'export_csv', 'get_run_status']) {
  assert.equal(tools[name].annotations?.readOnlyHint, true, `${name} is read-only`)
}
for (const name of ['delete_rows', 'delete_column', 'manage_table', 'import_csv', 'create_upload_link']) {
  assert.equal(tools[name].annotations?.destructiveHint, true, `${name} is destructive`)
}
// A one-time file link is a credential for one transfer: never read-only, and
// open world, so careful clients ask before making one.
for (const name of ['create_upload_link', 'create_download_link']) {
  assert.equal(tools[name].annotations?.readOnlyHint, false, `${name} is not read-only`)
  assert.equal(tools[name].annotations?.openWorldHint, true, `${name} is open world`)
}
assert.deepEqual(ok({ a: 1 }).structuredContent, { a: 1 })
assert.equal(ok([1]).structuredContent, undefined, 'structuredContent is only ever an object')
console.log('All mcp-annotations assertions passed.')
