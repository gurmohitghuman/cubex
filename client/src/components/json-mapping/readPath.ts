// Reading a path in the browser as the server reads it first (server
// lib/jsonpath-literal.ts; tests/unit/jsonpath-literal.test.ts holds the two
// together): `$`, then `.name`, `["key"]` (unescaped like jsonPath.ts writes it)
// and `[n]` steps, each an own property of a truthy value. Any other path (`*`,
// `..`) isn't read here: null steps. On a miss the server also asks jsonpath-plus.
import { unescapeKey } from './jsonPath'

const STEP = /\.([A-Za-z_$][A-Za-z0-9_$]*)|\["((?:[^"\\]|\\.)*)"\]|\[(\d+)\]/y
const hasOwn = Object.prototype.hasOwnProperty

export function literalSteps(path: string): string[] | null {
  if (!path.startsWith('$')) return null
  const steps: string[] = []
  STEP.lastIndex = 1
  while (STEP.lastIndex < path.length) {
    const m = STEP.exec(path)
    if (!m) return null
    steps.push(m[1] ?? (m[2] !== undefined ? unescapeKey(m[2]) : m[3]))
  }
  return steps
}

export function readLiteral(payload: unknown, steps: string[]): { matched: boolean; value: unknown } {
  if (!payload) return { matched: false, value: null }
  let cur: unknown = payload
  for (const key of steps) {
    if (!cur || !hasOwn.call(cur, key)) return { matched: false, value: null }
    cur = (cur as Record<string, unknown>)[key]
  }
  return { matched: true, value: cur }
}

// One form per value a path reads, to compare paths by: the steps for a path
// read literally (a mapping saved with a raw character in a key equals the
// escaped form the tree builds), else the path itself.
export function pathKey(path: string): string {
  const steps = literalSteps(path)
  return steps ? JSON.stringify(steps) : path
}
