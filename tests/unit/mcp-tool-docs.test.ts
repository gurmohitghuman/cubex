// Every MCP tool documented in full, as tools/list publishes it in both protocol eras: a title, its hints,
// a description, every input property at every depth described, and an outputSchema (an object, open to
// fields added later, with no $schema). A tool added without one of them fails here. Titles and hints live
// in server/src/mcp/tool-annotations.ts, output schemas in server/src/mcp/tool-outputs.ts.
import assert from 'node:assert/strict'
import { mcpHttpKit } from './mcp-http-kit'

type Schema = Record<string, unknown>
interface Tool {
  name: string; title?: string; description?: string; inputSchema: Schema; outputSchema?: Schema
  annotations?: Record<string, unknown>
}

const { check, done, crash, modern, legacy } = mcpHttpKit('mcp-tool-docs')
const HINTS = ['readOnlyHint', 'idempotentHint', 'openWorldHint'] as const
// Well over the size after output schemas were added and the descriptions trimmed (about 230K characters):
// a guard against a description or schema growing out of hand, not a target.
const MAX_LIST_CHARS = 260_000

const said = (v: unknown) => typeof v === 'string' && v.trim().length > 0

// The input properties at every depth (through arrays, records and unions) with no description.
function undescribed(node: unknown, at: string, out: string[]): string[] {
  if (!node || typeof node !== 'object') return out
  const s = node as Schema
  for (const [key, value] of Object.entries((s.properties ?? {}) as Record<string, Schema>)) {
    const here = at ? `${at}.${key}` : key
    if (!said(value?.description)) out.push(here)
    undescribed(value, here, out)
  }
  undescribed(s.items, `${at}[]`, out)
  if (typeof s.additionalProperties === 'object') undescribed(s.additionalProperties, `${at}{}`, out)
  for (const k of ['anyOf', 'oneOf', 'allOf']) for (const b of (s[k] ?? []) as unknown[]) undescribed(b, at, out)
  return out
}

// Where an output schema closes an object to new fields, or names a $schema, at any depth.
function closed(node: unknown, at: string, out: string[]): string[] {
  if (Array.isArray(node)) { node.forEach((n, i) => closed(n, `${at}[${i}]`, out)); return out }
  if (!node || typeof node !== 'object') return out
  for (const [key, value] of Object.entries(node as Schema)) {
    if ((key === 'additionalProperties' && value === false) || key === '$schema') out.push(`${at}.${key}`)
    closed(value, `${at}.${key}`, out)
  }
  return out
}

async function list(era: 'modern' | 'legacy'): Promise<{ tools: Tool[]; chars: number }> {
  const res = await (era === 'modern' ? modern('tools/list') : legacy('tools/list'))
  assert.equal(res.status, 200)
  const tools = (JSON.parse(res.text) as { result: { tools: Tool[] } }).result.tools
  return { tools, chars: JSON.stringify({ tools }).length }
}

// Each tool's problems, by name.
function problems(tools: Tool[]): string[] {
  const out: string[] = []
  for (const t of tools) {
    const ann = t.annotations ?? {}
    if (!said(t.title)) out.push(`${t.name}: no title`)
    for (const h of HINTS) if (typeof ann[h] !== 'boolean') out.push(`${t.name}: no ${h}`)
    if (ann.readOnlyHint === false && typeof ann.destructiveHint !== 'boolean') {
      out.push(`${t.name}: a tool that writes needs destructiveHint`)
    }
    if (!said(t.description) || t.description!.length < 80) out.push(`${t.name}: no description, or a stub`)
    for (const p of undescribed(t.inputSchema, '', [])) out.push(`${t.name}: input ${p} has no description`)
    const o = t.outputSchema
    if (!o || o.type !== 'object' || typeof o.properties !== 'object') {
      out.push(`${t.name}: no outputSchema with object properties`)
    } else {
      for (const p of closed(o, 'outputSchema', [])) out.push(`${t.name}: ${p} (output schemas stay open)`)
    }
  }
  return out
}

async function main() {
  const modernList = await list('modern'), legacyList = await list('legacy')
  console.log(`tools/list: ${modernList.tools.length} tools, ${modernList.chars} characters`)

  await check('every tool has a title, hints, a description, described inputs and an open outputSchema', () => {
    assert.ok(modernList.tools.length >= 60, `only ${modernList.tools.length} tools listed`)
    assert.deepEqual(problems(modernList.tools), [])
  })

  await check('the 2025 era lists the same tools with the same documentation', () => {
    assert.deepEqual(legacyList.tools, modernList.tools)
  })

  await check(`tools/list stays under ${MAX_LIST_CHARS.toLocaleString('en-US')} characters`, () => {
    assert.ok(modernList.chars <= MAX_LIST_CHARS, `tools/list is ${modernList.chars} characters`)
  })

  await check('published text has no em dash', () => {
    const text = JSON.stringify(modernList.tools)
    assert.equal(text.includes('\u2014'), false, 'an em dash in a description or title')
  })

  done()
}

main().catch(crash)
