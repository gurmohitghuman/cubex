// Helpers for mcp-tool-list.test.ts: input schemas without their wording, the release tags this checkout
// has, what a tag shipped of the changes file (server/src/mcp/agent-changes.ts), and a tag's own tool list,
// read from that tag's code.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import versionMod from '../../server/src/lib/cubex-version'
const { parseTag, compareVersions } = versionMod as typeof import('../../server/src/lib/cubex-version')

export type Schemas = Record<string, unknown>
export interface Recorded { release: string; tools: Schemas }
export const CHANGES = 'server/src/mcp/agent-changes.ts'

export const exact = (v: string) => { const t = parseTag(v); return !!t && `v${t.major}.${t.minor}.${t.patch}` === v }
export const newer = (a: string, b: string) => compareVersions(parseTag(a)!, parseTag(b)!) > 0
export const nextPatch = (v: string) => { const t = parseTag(v)!; return `v${t.major}.${t.minor}.${t.patch + 1}` }

// A schema without its wording, keys and required names sorted. A property named "description" is a
// schema (an object), so only the keywords go.
export function contract(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(contract)
  if (!node || typeof node !== 'object') return node
  const kept = Object.entries(node).filter(([k, v]) =>
    !(['description', 'title', '$schema'].includes(k) && typeof v === 'string') && k !== 'examples')
  return Object.fromEntries(kept.sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) =>
    [k, k === 'required' && Array.isArray(v) ? [...v].sort() : contract(v)]))
}

// tools/list's tools by name, as the recorded list keeps them.
export const byName = (tools: Array<{ name: string; inputSchema: unknown }>): Schemas =>
  Object.fromEntries(tools.map(t => [t.name, contract(t.inputSchema)] as const).sort(([a], [b]) => a.localeCompare(b)))

const git = (args: string[], cwd?: string) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// The vX.Y.Z tags this checkout has, newest first. None without git, or in CI, which checks out one commit.
export function releaseTags(): string[] {
  let out: string
  try { out = git(['tag', '--list', 'v*']) } catch { return [] }
  return out.split('\n').map(t => t.trim()).filter(exact).sort((a, b) => compareVersions(parseTag(b)!, parseTag(a)!))
}

// What a tag shipped of the changes file, from its newest release down, and the same part of text. Later
// commits add releases above it and keep this part as it is (scripts/release.sh cut checks the same).
// Null when the tag had no changes file.
export function shippedPart(tag: string, text: string): { shipped: string; now: string | null; first: string } | null {
  let then: string
  try { then = git(['show', `refs/tags/${tag}:${CHANGES}`]) } catch { return null }
  const first = /^ *version: '(v\d+\.\d+\.\d+)',/m.exec(then)?.[1]
  if (!first) return null
  const from = (s: string) => {
    const at = s.search(new RegExp(`^ *version: '${first.replace(/\./g, '\\.')}',`, 'm'))
    return at < 0 ? null : s.slice(at)
  }
  return { shipped: from(then)!, now: from(text), first }
}

const DUMP = `// Written by mcp-tool-list-kit.ts into a temporary checkout of a release, and deleted with it.
import fs from 'node:fs'
import { mcpHttpKit } from './mcp-http-kit'
const { done, crash, modern } = mcpHttpKit('tool-list-dump')
modern('tools/list').then(res => {
  fs.writeFileSync(process.env.TOOL_LIST_TO as string, JSON.stringify(JSON.parse(res.text).result.tools))
  done()
}).catch(crash)
`

// A release's own tools: its code checked out in a temporary folder with this checkout's packages, and
// its tools/list read the way the test reads today's. So a list recorded after main moved on is still
// exactly the release's.
export function toolsAt(tag: string): Schemas {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-list-'))
  const tree = path.join(dir, 'tree')
  const out = path.join(dir, 'tools.json')
  git(['worktree', 'add', '--detach', tree, `refs/tags/${tag}`])
  try {
    fs.symlinkSync(path.resolve('node_modules'), path.join(tree, 'node_modules'), 'junction')
    fs.writeFileSync(path.join(tree, 'tests', 'unit', 'zz-tool-list-dump.test.ts'), DUMP)
    try {
      execFileSync(process.execPath, [path.join('scripts', 'unit-tests.mjs'), 'zz-tool-list-dump'],
        { cwd: tree, env: { ...process.env, TOOL_LIST_TO: out }, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      throw new Error(`reading ${tag}'s tools failed: ${String((e as { stdout?: Buffer }).stdout ?? '').slice(-2000)}`)
    }
    return byName(JSON.parse(fs.readFileSync(out, 'utf8')))
  } finally {
    git(['worktree', 'remove', '--force', tree])
  }
}
