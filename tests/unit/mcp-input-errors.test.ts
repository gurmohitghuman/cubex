// Arguments a tool refuses, in plain words (mcp/input-errors.ts, error-answers.ts): each issue names the
// field, what it takes (type, range, choices, as tools/list publishes them) and what was sent; a message a
// schema sets itself stays. Through /mcp in both eras: a refusal is still a tool result with isError and
// the SDK's first words; a tools/call whose arguments aren't an object is still -32602, in plain words. A
// header naming a version Cubex doesn't speak, on a body naming none, gets 400 with -32022 and every version
// it speaks; a body naming one is still the SDK's to answer, with the same next step.
import assert from 'node:assert/strict'
import { z } from 'zod'
import inputMod from '../../server/src/mcp/input-errors'
import { mcpHttpKit, META, headersFor } from './mcp-http-kit'
const { plainArgumentErrors, plainRequestError } = inputMod as typeof import('../../server/src/mcp/input-errors')

const { check, done, crash, post, modern, legacy } = mcpHttpKit('mcp-input-errors')
const EVERY = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
const NEXT = 'Send one of the versions in data.supported, newest first.'

const schema = z.object({
  sheet_id: z.string().describe('The sheet\'s id (list_tables lists them)'),
  limit: z.number().int().min(1).max(100).optional(),
  from: z.number().int().min(1).optional(),
  name: z.string().min(1).max(200).optional(),
  tags: z.array(z.string()).min(1).max(3).optional(),
  ids: z.array(z.string()).min(1).optional(),
  mode: z.enum(['copy', 'move']).optional(),
  url: z.string().url().optional(),
  pick: z.union([z.string(), z.array(z.string())]).optional(),
  where: z.array(z.union([z.object({ column: z.string(), operator: z.enum(['eq', 'gt']) }),
    z.object({ any: z.array(z.unknown()) })])).optional(),
  sub: z.object({ k: z.number() }).strict().optional(),
  own: z.number('own must be a number from 1 to 9.').min(1, 'own must be a number from 1 to 9.').optional(),
}).strict()
const words = (args: unknown) => plainArgumentErrors(schema, args)

async function main() {
  await check('a missing field says it is required, what it takes and what it is; a wrong type, what was sent', () => {
    assert.deepEqual(words({}), ['sheet_id is required (text): The sheet\'s id (list_tables lists them).'])
    assert.deepEqual(words({ sheet_id: 5 }), ['sheet_id must be text, not 5.'])
    assert.deepEqual(words({ sheet_id: 's', name: ['a'] }), ['name must be text from 1 to 200 characters, not a list '
      + 'of 1.'])
    assert.equal(words({ sheet_id: 's' }), null)
  })

  await check('out of range gives the range: both ends, one end, lengths and list sizes', () => {
    assert.deepEqual(words({ sheet_id: 's', limit: 0, from: 0, name: '', tags: ['a', 'b', 'c', 'd'], ids: [] }), [
      'limit must be a whole number from 1 to 100, not 0.', 'from must be a whole number of 1 or more, not 0.',
      'name must be text from 1 to 200 characters, not empty text.', 'tags must be a list from 1 to 3 items, not a '
        + 'list of 4.', 'ids must be a list of at least 1 item, not a list of 0.'])
  })

  await check('choices, formats, unknown fields, unions and a schema\'s own words', () => {
    assert.deepEqual(words({ sheet_id: 's', mode: 'merge', url: 'nope', pick: 3, sub: { k: 1, j: 2 }, own: 0, x: 1 }), [
      'mode must be one of "copy", "move", not text "merge".', 'url must be a URL such as https://example.com/a, '
        + 'not text "nope".', 'pick must be text or a list, not 3.', 'sub has no field "j" (it takes k).',
      'own: own must be a number from 1 to 9.', 'This tool takes no field "x" (it takes sheet_id, limit, from, name, '
        + 'tags, ids, mode, url, pick, where, sub, own).'])
    assert.deepEqual(words({ sheet_id: 's', where: [{ column: 'a', operator: 'equals' }] }),
      ['where.0.operator must be one of "eq", "gt", not text "equals".'])
  })

  await check('a request that isn\'t one: the SDK\'s raw list of issues in plain words; other words: none', () => {
    const dump = (issues: unknown[]) => `Invalid tools/call request: ${JSON.stringify(issues, null, 2)}`
    assert.equal(plainRequestError(dump([{ expected: 'record', code: 'invalid_type', path: ['params', 'arguments'],
      message: 'Invalid input: expected record, received string' }])),
    'Invalid tools/call request: params.arguments must be an object, not text.')
    assert.equal(plainRequestError(dump([{ expected: 'string', code: 'invalid_type', path: ['params', 'name'],
      message: 'Invalid input: expected string, received undefined' }])),
    'Invalid tools/call request: params.name is required (text).')
    assert.equal(plainRequestError('Tool nope not found'), null)
  })

  await check('through /mcp in both eras: a tool result with the SDK\'s first words, then plain ones', async () => {
    const prefix = 'Input validation error: Invalid arguments for tool read_rows: '
    for (const send of [modern, legacy]) {
      for (const [args, text] of [
        [{ sheet_id: 5 }, 'sheet_id must be text, not 5.'],
        [{}, 'sheet_id is required (text): The sheet\'s id (list_tables lists them).'],
        [{ sheet_id: 's', limit: 0 }, 'limit must be a whole number from 1 to 100, not 0.'],
        [{ sheet_id: 's', max_chars_per_cell: 0 },
          'max_chars_per_cell: max_chars_per_cell must be an integer from 1 to 200000.'],
      ] as const) {
        const result = JSON.parse((await send('tools/call', { name: 'read_rows', arguments: args }, 'read_rows')).text)
          .result
        assert.deepEqual([result.isError, result.content], [true, [{ type: 'text', text: prefix + text }]])
      }
    }
  })

  await check('arguments that aren\'t an object: still -32602 with the request\'s id, in plain words', async () => {
    for (const [send, args, what] of [[modern, 'x', 'text'], [legacy, [1], 'a list']] as const) {
      const res = await send('tools/call', { name: 'get_sheet', arguments: args }, 'get_sheet')
      assert.deepEqual([res.status, JSON.parse(res.text)], [200, { jsonrpc: '2.0', id: res.id, error: { code: -32602,
        message: `Invalid tools/call request: params.arguments must be an object, not ${what}.` } }])
    }
  })

  await check('a header naming a version Cubex doesn\'t speak, on a body naming none: 400, -32022, every version',
    async () => {
      for (const method of ['tools/list', 'initialize']) {
        const res = await post({ jsonrpc: '2.0', id: 7, method, params: {} }, { 'mcp-protocol-version': '2099-01-01' })
        assert.deepEqual([res.status, JSON.parse(res.text)], [400, { jsonrpc: '2.0', id: 7, error: { code: -32022,
          message: `Unsupported protocol version: 2099-01-01. ${NEXT}`,
          data: { supported: EVERY, requested: '2099-01-01' } } }])
      }
      const old = await post({ jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} },
        { 'mcp-protocol-version': '2025-06-18' })
      assert.equal(JSON.parse(old.text).result.tools.length > 60, true)
    })

  await check('a body naming a version Cubex doesn\'t speak: the SDK\'s -32022, with the same next step', async () => {
    const asked = { ...META, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' }
    const res = await post({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: { _meta: asked } },
      headersFor('tools/list', undefined, '2099-01-01'))
    assert.deepEqual([res.status, JSON.parse(res.text).error], [400, { code: -32022,
      message: `Unsupported protocol version: 2099-01-01. ${NEXT}`,
      data: { supported: EVERY, requested: '2099-01-01' } }])
  })
  done()
}
main().catch(crash)
