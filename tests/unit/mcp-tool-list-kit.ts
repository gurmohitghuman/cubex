// Helpers for mcp-tool-list.test.ts: input schemas without their wording, the release tags this checkout
// has, what a tag shipped of the changes file (server/src/mcp/agent-changes.ts), a tag's own tool list,
// read from that tag's code, and what a recording reads and checks (mcp-tool-list-record.test.ts).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import versionMod from '../../server/src/lib/cubex-version'
const { parseTag, compareVersions } = versionMod as typeof import('../../server/src/lib/cubex-version')

export type Schemas = Record<string, unknown>
// What a line names, which the recording checks against the tools: its wording is left out.
export interface LineShape { change: string; tools?: string[]; replaced_by?: string }
// The list recorded: a release, its lines as they were checked, and its tools.
export interface Recorded { release: string; lines?: LineShape[]; tools: Schemas }
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

// The lines as the recorded list keeps them.
export const shapes = (changes: LineShape[]): LineShape[] => changes.map(c => ({
  change: c.change, ...(c.tools ? { tools: [...c.tools] } : {}),
  ...(c.replaced_by ? { replaced_by: c.replaced_by } : {}),
}))

// Null when the changes file's lines for the release recorded still name what they named when its list was
// recorded, else what is wrong. listed: the changes file's releases and their lines.
export function linesChanged(recorded: Recorded, listed: Array<{ version: string; changes: LineShape[] }>):
  string | null {
  const now = listed.find(r => r.version === recorded.release)
  if (isDeepStrictEqual(shapes(now?.changes ?? []), recorded.lines ?? [])) return null
  const r = recorded.release
  return `${CHANGES}'s lines for ${r} name other changes or tools than when its list was recorded. `
    + `A change after ${r} goes under a later release; before ${r} is out, record it again.`
}

// What MCP_TOOL_LIST_RECORD=release reads and checks, or why it can't. A release tag: its own code, against
// the list recorded (a release recorded after its tag). Not a tag yet: the newest release the changes file
// lists, newer than the newest tag, read from this checkout's code, against the release listed before it,
// which must be out: the list recorded when that is the one recorded, else that tag's own code (the same
// release recorded again, or renumbered). listed: the changes file's releases, newest first; tags too.
export type RecordPlan = { refused: string } | { from: 'tag' | 'here'; base: string; baseFrom: 'file' | 'tag' }
export function recordPlan(release: string, recorded: string, listed: string[], tags: string[]): RecordPlan {
  if (!exact(release)) return { refused: `give the release as vX.Y.Z: ${release}` }
  if (tags.includes(release)) {
    return newer(release, recorded) ? { from: 'tag', base: recorded, baseFrom: 'file' }
      : { refused: `${release} is not after ${recorded}, the release recorded` }
  }
  if (!tags.length) return { refused: 'no release tags here: git fetch --tags' }
  if (listed[0] !== release) {
    return { refused: `${release} is not the newest release ${CHANGES} lists (${listed[0] ?? 'none'})` }
  }
  if (!newer(release, tags[0])) return { refused: `${release} is not after the newest tag, ${tags[0]}` }
  const before = listed[1]
  if (!before || !tags.includes(before)) {
    return { refused: `the release listed before ${release} (${before ?? 'none'}) is not a release tag here` }
  }
  if (before === recorded) return { from: 'here', base: before, baseFrom: 'file' }
  if (newer(recorded, before)) return { from: 'here', base: before, baseFrom: 'tag' }
  return { refused: `${before} is out with changes for agents and the list recorded is ${recorded}'s: `
    + `record ${before}'s first` }
}
