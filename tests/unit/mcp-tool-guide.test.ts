// get_tool_guide and the tool guides (server/src/mcp/guides). When the longest tool descriptions were cut down,
// their details moved to the guides: mcp-tool-guide-before.json keeps each changed tool's description and the
// changed input-field notes as they were then (v0.8.45, before the move), and every sentence of them must still
// be in the tool's description, an input field's notes or its guide, word for word (whitespace aside). A later
// change that rewords or drops one of those facts on purpose edits the file with it. Also: a tool with a guide
// says so at the end of its description, and get_tool_guide answers a guide, the list, and a wrong name.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import guideMod from '../../server/src/services/tool-guide'
import guidesMod from '../../server/src/mcp/guides'
import pointerMod from '../../server/src/mcp/guides/guide'
import { mcpHttpKit } from './mcp-http-kit'
const { toolGuide } = guideMod as typeof import('../../server/src/services/tool-guide')
const { TOOL_GUIDES } = guidesMod as typeof import('../../server/src/mcp/guides')
const { GUIDE_POINTER } = pointerMod as typeof import('../../server/src/mcp/guides/guide')

type Schema = { description?: string; properties?: Record<string, Schema>; items?: Schema;
  additionalProperties?: Schema | boolean; anyOf?: Schema[]; oneOf?: Schema[]; allOf?: Schema[] }
interface Tool { name: string; description: string; inputSchema: Schema }
interface Before { description: string; fields?: Record<string, string> }

const { check, done, crash, modern } = mcpHttpKit('mcp-tool-guide')
const BEFORE = JSON.parse(fs.readFileSync(path.join('tests', 'unit', 'mcp-tool-guide-before.json'), 'utf8')) as
  Record<string, Before>

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
// A sentence ends at . ! or ? before a space ("e.g." splits too: both parts must be there).
const sentences = (text: string) => norm(text).split(/(?<=[.!?]) (?=\S)/).filter(Boolean)
// Every input field's notes, at any depth.
function notes(node: Schema | undefined, out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out
  for (const field of Object.values(node.properties ?? {})) {
    if (typeof field.description === 'string') out.push(field.description)
    notes(field, out)
  }
  notes(node.items, out)
  if (typeof node.additionalProperties === 'object') notes(node.additionalProperties, out)
  for (const branch of [...node.anyOf ?? [], ...node.oneOf ?? [], ...node.allOf ?? []]) notes(branch, out)
  return out
}
const guideOf = (name: string) => {
  const out = toolGuide(name)
  return 'ok' in out && 'guide' in out.ok ? out.ok.guide : ''
}

async function main() {
  const tools = new Map((JSON.parse((await modern('tools/list')).text).result.tools as Tool[]).map(t => [t.name, t]))

  await check('every sentence a changed tool said is still in its description, its fields or its guide', () => {
    const missing: string[] = []
    for (const [name, before] of Object.entries(BEFORE)) {
      const tool = tools.get(name)
      assert.ok(tool, `${name} is not listed`)
      const now = norm([tool.description, ...notes(tool.inputSchema), guideOf(name)].join('\n'))
      const said = [before.description, ...Object.values(before.fields ?? {})]
      for (const s of said.flatMap(sentences)) if (!now.includes(s)) missing.push(`${name}: ${s}`)
    }
    assert.deepEqual(missing, [])
  })

  // The REST document describes these fields with the guide's notes (openapi/tool-schemas.ts), as it did before.
  await check('a field cut to one line has its old notes in the guide word for word', () => {
    for (const [name, before] of Object.entries(BEFORE)) {
      for (const [field, notes] of Object.entries(before.fields ?? {})) {
        assert.equal(TOOL_GUIDES[name as keyof typeof TOOL_GUIDES]?.fields?.[field], notes, `${name}.${field}`)
      }
    }
  })

  await check('a tool has a guide exactly when its description ends by pointing to it', () => {
    const pointing = [...tools.values()].filter(t => t.description.endsWith(` ${GUIDE_POINTER}`)).map(t => t.name)
    assert.deepEqual(pointing.sort(), Object.keys(TOOL_GUIDES).sort())
    for (const name of Object.keys(TOOL_GUIDES)) assert.ok(tools.has(name), `${name} has a guide but is not listed`)
  })

  await check('every changed tool has a guide', () => {
    assert.ok(Object.keys(BEFORE).length >= 15, `${Object.keys(BEFORE).length} tools`)
    assert.deepEqual(Object.keys(BEFORE).filter(n => !(n in TOOL_GUIDES)), [])
  })

  await check('get_tool_guide: a guide, the list, a tool with no guide, and a misspelled name', async () => {
    const call = async (args: Record<string, unknown>) => JSON.parse((await modern('tools/call',
      { name: 'get_tool_guide', arguments: args }, 'get_tool_guide')).text).result
    const one = await call({ tool: 'read_rows' })
    assert.equal(one.isError, undefined)
    assert.deepEqual(one.structuredContent, { tool: 'read_rows', guide: guideOf('read_rows') })
    assert.match(one.structuredContent.guide, /\n- where: Rows must pass every item\./)
    const list = await call({})
    assert.deepEqual(list.structuredContent, { tools: Object.keys(TOOL_GUIDES).sort() })
    assert.match((await call({ tool: 'list_tables' })).structuredContent.guide, /^list_tables has no guide/)
    const wrong = await call({ tool: 'red_rows' })
    assert.equal(wrong.isError, true)
    assert.match(wrong.content[0].text, /No tool is named \\"red_rows\\"\. Close matches: read_rows/)
  })

  done()
}
main().catch(crash)
