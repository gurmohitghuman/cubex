// The JSON tree's pure parts (JsonTree.tsx renders them): which containers open
// by themselves, how much of a string shows, what a hostile string looks like
// on screen, and which paths can become a column. No React, no DOM: unit-tested
// by tests/unit/json-tree-model.test.ts.
import { appendIndex, appendKey, defaultColumnName } from './jsonPath'
import {
  BS, codePointAt, flagTagsEnd, isHiddenAstral, isHiddenBmp, isStackingMark, MARKS_KEPT, unitEscape,
} from './hidden-chars'
import { JSON_PATH_MAX_CHARS, JSON_TREE_NAME_MAX } from '../../lib/constants'

export type Container = unknown[] | Record<string, unknown>

export const isContainer = (v: unknown): v is Container => v !== null && typeof v === 'object'

// Object.keys, not entries: a container with 100k fields lists its keys once
// and reads only the values on the page shown.
export function childKeys(v: Container): string[] | null {
  return Array.isArray(v) ? null : Object.keys(v)
}

export function countLabel(n: number, array: boolean): string {
  const word = array ? (n === 1 ? 'item' : 'items') : (n === 1 ? 'field' : 'fields')
  return `${n.toLocaleString('en-US')} ${word}`
}

export interface Start { v: unknown; path: string; depth: number }

// A page of a container's children, as starts for openPaths.
export function pageStarts(v: Container, path: string, depth: number, from: number, page: number): Start[] {
  const keys = childKeys(v)
  const total = keys ? keys.length : (v as unknown[]).length
  const out: Start[] = []
  for (let c = from; c < Math.min(total, from + page); c++) {
    out.push(keys
      ? { v: (v as Record<string, unknown>)[keys[c]], path: appendKey(path, keys[c]), depth }
      : { v: (v as unknown[])[c], path: appendIndex(path, c), depth })
  }
  return out
}

// The containers that open by themselves, top down (breadth first) so outer
// levels open before inner ones: each one opened shows its first page, and
// opening stops once the rows shown would pass `maxRows` (the first always
// opens). `complete` is false when a container stayed closed for the budget or
// the depth, so "Expand all" can say it opened only what fits.
export function openPaths(starts: Start[], maxDepth: number, maxRows: number, page: number):
  { open: Set<string>; complete: boolean } {
  const open = new Set<string>()
  const queue = [...starts]
  let rows = starts.length
  let complete = true
  for (let i = 0; i < queue.length; i++) {
    const { v, path, depth } = queue[i]
    if (!isContainer(v)) continue
    if (depth >= maxDepth) {
      if (Array.isArray(v) ? v.length > 0 : hasAnyKey(v)) complete = false
      continue
    }
    const keys = childKeys(v)
    const total = keys ? keys.length : (v as unknown[]).length
    if (total === 0) continue
    const shown = Math.min(total, page)
    if (open.size > 0 && rows + shown > maxRows) { complete = false; continue }
    open.add(path)
    rows += shown
    queue.push(...pageStarts(v, path, depth + 1, 0, page))
  }
  return { open, complete }
}

function hasAnyKey(v: object): boolean {
  for (const k in v) if (Object.prototype.hasOwnProperty.call(v, k)) return true
  return false
}

// The first `n` UTF-16 units of `s`, never splitting a surrogate pair, and how
// many are left out.
export function cutText(s: string, n: number): { text: string; rest: number } {
  if (s.length <= n) return { text: s, rest: 0 }
  let end = Math.max(0, n)
  const last = s.charCodeAt(end - 1)
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--
  return { text: s.slice(0, end), rest: s.length - end }
}

// Text as the tree shows it: each hidden character (hidden-chars.ts), lone
// surrogate, and stacked mark past the third in a row is written out the way
// JSON escapes it (backslash n, t or r, else backslash u and four hex digits;
// above the BMP backslash u and the code point in braces), so a reply can't hide
// words, reorder what's around it, paint over other rows or pass for something
// else. React renders it as text, never markup.
export const visibleText = (s: string): string => rewriteHidden(s, true)

function rewriteHidden(s: string, escape: boolean): string {
  let out = ''
  let from = 0
  let marks = 0
  for (let i = 0; i < s.length;) {
    const { cp, width, lone } = codePointAt(s, i)
    const flagEnd = cp === 0x1f3f4 ? flagTagsEnd(s, i + width) : -1
    if (flagEnd > 0) { marks = 0; i = flagEnd; continue }
    marks = isStackingMark(cp) ? marks + 1 : 0
    const hidden = lone || (width === 1 ? isHiddenBmp(cp) : isHiddenAstral(cp)) || marks > MARKS_KEPT
    if (hidden) {
      const esc = cp === 0x0a ? BS + 'n' : cp === 0x09 ? BS + 't' : cp === 0x0d ? BS + 'r'
        : width === 2 ? BS + 'u{' + cp.toString(16).toUpperCase() + '}' : unitEscape(cp)
      // Stripped, a line break or tab is a space, as the server does with a name.
      out += s.slice(from, i) + (escape ? esc : cp === 0x0a || cp === 0x09 || cp === 0x0d ? ' ' : '')
      from = i + width
    }
    i += width
  }
  return from === 0 ? s : out + s.slice(from)
}

// A short, visible form of a path for a tooltip or a toast.
export function pathLabel(path: string, max = 120): string {
  const cut = cutText(path, max)
  return visibleText(cut.text) + (cut.rest ? '…' : '')
}

// The name "Add as column" suggests: the path's last key without what can't be
// seen, short enough for the server (a column name is at most 200 characters).
export function suggestedName(path: string): string {
  const name = rewriteHidden(defaultColumnName(path), false).replace(/\s+/g, ' ').trim()
  return cutText(name, JSON_TREE_NAME_MAX).text.trim() || 'value'
}

// "Add as column" only offers paths the server takes.
export const canMapPath = (path: string): boolean => path.length <= JSON_PATH_MAX_CHARS
