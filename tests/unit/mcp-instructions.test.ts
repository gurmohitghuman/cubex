// The server instructions (mcp/instructions.ts) checked against the tools as tools/list gives them: they start
// with get_workspace, every tool they name exists, every field they name is one of the tool they name it with
// (an input, or a field of its answer), they stay under 2,000 characters (half of what they were) and carry no
// em dash; server/discover answers them with the release note before and the token's spend cap after.
import assert from 'node:assert/strict'
import instructionsMod from '../../server/src/mcp/instructions'
import spendMod from '../../server/src/lib/token-spend'
import { mcpHttpKit } from './mcp-http-kit'
const { GUIDE, serverInstructions } = instructionsMod as typeof import('../../server/src/mcp/instructions')
const { capToolNote } = spendMod as typeof import('../../server/src/lib/token-spend')

const { spend, check, done, crash, modern } = mcpHttpKit('mcp-instructions')
type Tool = { name: string; inputSchema: { properties?: object }; outputSchema?: { properties?: object } }

// Each field the guide names, with the tools it names it for, and where it is: what the tool takes, or answers.
const FIELDS: Record<string, { tools: string[]; in: 'input' | 'output' }> = {
  column_details: { tools: ['get_sheet'], in: 'output' },
  where: { tools: ['read_rows'], in: 'input' },
  group_by: { tools: ['read_rows'], in: 'input' },
  aggregates: { tools: ['read_rows'], in: 'input' },
  include_status: { tools: ['read_rows'], in: 'input' },
  dry_run: { tools: ['remove_duplicates'], in: 'input' },
  estimate_only: {
    tools: ['run_ai_column', 'run_http_enrichment', 'run_enrichment', 'waterfall_column', 'apply_setup'], in: 'input',
  },
  run_id: { tools: ['run_ai_column', 'run_http_enrichment', 'run_enrichment', 'waterfall_column'], in: 'output' },
}

async function main() {
  const listed = JSON.parse((await modern('tools/list')).text).result.tools as Tool[]
  const tools = new Map(listed.map(t => [t.name, t]))

  await check('the guide starts with get_workspace, a tool that exists', () => {
    assert.ok(GUIDE.startsWith('Start with get_workspace: '), GUIDE.slice(0, 60))
    assert.ok(tools.has('get_workspace'))
  })

  await check('every name in the guide is a tool, or a field it names with its tool', () => {
    const named = [...new Set(GUIDE.match(/\b[a-z]+(?:_[a-z]+)+\b/g))]
    const unknown = named.filter(n => !tools.has(n) && !(n in FIELDS))
    assert.deepEqual(unknown, [], `names that are no tool and no listed field: ${unknown.join(', ')}`)
    // The single words among the fields are checked too.
    for (const field of Object.keys(FIELDS)) assert.match(GUIDE, new RegExp(`\\b${field}\\b`), field)
  })

  await check('each field is one of the tools the guide names it with', () => {
    for (const [field, { tools: names, in: where }] of Object.entries(FIELDS)) {
      for (const name of names) {
        const tool = tools.get(name)
        assert.ok(tool, `${name} is no tool`)
        const props = (where === 'input' ? tool.inputSchema : tool.outputSchema)?.properties ?? {}
        assert.ok(field in props, `${name} has no ${where} field ${field}`)
        assert.match(GUIDE, new RegExp(`\\b${name}\\b`), `the guide doesn't name ${name}`)
      }
    }
  })

  await check('short, and no em dash', () => {
    assert.ok(GUIDE.length < 2000, `${GUIDE.length} characters`)
    assert.ok(!serverInstructions(spend).includes('\u2014'))
  })

  await check('server/discover: the release note, the guide, then the token\'s spend cap', async () => {
    const { instructions } = JSON.parse((await modern('server/discover')).text).result
    assert.equal(instructions, serverInstructions(spend))
    assert.ok(instructions.startsWith('Cubex is a spreadsheet workspace. This server does not record its Cubex '))
    assert.ok(instructions.endsWith(GUIDE + capToolNote(spend, true)))
  })

  done()
}
main().catch(crash)
