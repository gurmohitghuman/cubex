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

// The changes file as the tag shipped it, or null when the tag had none.
export function changesAt(tag: string): string | null {
  try { return git(['show', `refs/tags/${tag}:${CHANGES}`]) } catch { return null }
}

// The releases a changes file lists, newest first.
export const versionsIn = (text: string) => [...text.matchAll(/\bversion: '(v\d+\.\d+\.\d+)'/g)].map(m => m[1])

// Null when text keeps what the tag shipped of the changes file, else what is wrong. What it shipped is the
// file from its newest release down: later commits add releases above it and keep this part as it is. A
// release text lists that is not newer than the tag, and that the tag didn't ship, is an edit too (a release
// out with no lines gets none afterwards). scripts/release.sh cut checks the same. A tag from before the
// file shipped nothing to keep.
export function shippedEdit(tag: string, text: string): string | null {
  const then = changesAt(tag)
  if (then === null) return null
  const first = versionsIn(then)[0]
  const kept = versionsIn(text).find(v => !newer(v, tag))
  const after = `A change made after ${tag} goes under a later release.`
  if (kept && (!first || newer(kept, first))) {
    const shipped = first ? `${first} as its newest lines` : 'no lines'
    return `${CHANGES} lists ${kept}, but ${tag} shipped ${shipped}. ${after}`
  }
  const from = (s: string) => {
    const at = first ? s.search(new RegExp(`^.*\\bversion: '${first.replace(/\./g, '\\.')}'`, 'm')) : -1
    return at < 0 ? null : s.slice(at)
  }
  return kept === first && from(then) === from(text) ? null
    : `${CHANGES} changes what ${tag} shipped (${first} and older). ${after}`
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
