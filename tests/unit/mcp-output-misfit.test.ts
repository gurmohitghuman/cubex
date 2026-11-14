// Outside e2e (no CUBEX_TEST_STRICT_OUTPUT), an answer that doesn't fit its tool's outputSchema is answered as
// it is and logged once: the call has done its work, so it must never come back as an error
// (server/src/mcp/output-schema.ts toolOutput). Through the SDK's own server and client, as tools/call runs.
import assert from 'node:assert/strict'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import schemaMod from '../../server/src/mcp/output-schema'
const { STRICT_OUTPUT, obj, toolOutput } = schemaMod as typeof import('../../server/src/mcp/output-schema')

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const warned: string[] = []
console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(' ')) }

interface Answer { content: Array<{ type: string; text: string }>; structuredContent?: unknown; isError?: boolean }

async function main() {
  if (STRICT_OUTPUT) throw new Error('Run this without CUBEX_TEST_STRICT_OUTPUT: it checks the production path.')
  const server = new McpServer({ name: 'unit', version: '1' })
  const answers: Record<string, unknown> = {
    fits: { count: 3, rows: [{ id: 'a' }] },
    wrong_type: { count: 'three', rows: [{ id: 'a' }] },
    missing: { rows: [{ id: 'a' }, { id: 7 }, { id: 8 }] },
  }
  let calls = 0
  server.registerTool('unit_misfit', {
    description: 'Answers what it is asked to', inputSchema: z.object({ answer: z.string() }),
    outputSchema: toolOutput('unit_misfit', obj({ count: z.number(), rows: z.array(obj({ id: z.string() })) })) as
      z.ZodObject<z.ZodRawShape>,
  }, async ({ answer }) => {
    calls++
    const data = answers[answer] as Record<string, unknown>
    return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data }
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'unit', version: '1' })
  await client.connect(clientSide)
  const call = async (answer: string) =>
    await client.callTool({ name: 'unit_misfit', arguments: { answer } }) as Answer

  await check('an answer that fits is answered and nothing is logged', async () => {
    const res = await call('fits')
    assert.notEqual(res.isError, true)
    assert.deepEqual(res.structuredContent, answers.fits)
    assert.deepEqual(warned, [])
  })

  await check('a field of the wrong type is answered as it is, and logged with the tool and the field', async () => {
    const res = await call('wrong_type')
    assert.notEqual(res.isError, true, res.content[0]?.text)
    assert.deepEqual(res.structuredContent, answers.wrong_type)
    assert.equal(warned.length, 1)
    assert.match(warned[0],
      /^MCP tool unit_misfit: its answer does not fit its outputSchema \(answered anyway\): count: /)
  })

  await check('a missing field and wrong ones in a list are answered, logged once with [] for places', async () => {
    const res = await call('missing')
    assert.notEqual(res.isError, true, res.content[0]?.text)
    assert.deepEqual(res.structuredContent, answers.missing)
    assert.equal(warned.length, 2)
    assert.match(warned[1], /count: .*; rows\.\[\]\.id: .*; rows\.\[\]\.id: /)
  })

  await check('the same misfit again is answered without logging it again', async () => {
    const res = await call('wrong_type')
    assert.notEqual(res.isError, true)
    assert.equal(warned.length, 2)
    assert.equal(calls, 4)
  })

  await check('listed tools still publish the schema as before', async () => {
    const { tools } = await client.listTools()
    const out = tools.find(t => t.name === 'unit_misfit')?.outputSchema as Record<string, unknown> | undefined
    assert.equal(out?.type, 'object')
    assert.deepEqual(Object.keys(out?.properties as object), ['count', 'rows'])
    assert.equal('additionalProperties' in (out ?? {}), false)
  })
  await client.close()
}

main().then(() => {
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}, e => { console.log('FAIL', (e as Error).stack); process.exit(1) })
