// Setups in the app (pure): the column of a sheet an input goes to, and which
// of a sheet's filled columns a chosen one brings with it. A step reads
// columns; the step that made a column it reads comes too, down the chain (the
// server's include-upstream rule, so the dialog can show the ticks before
// saving). A step that can't be saved (problem) never comes; what it made
// stays an input.
import type { SheetSetupStep } from '@/utils/api/setups'

const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

// The sheet column a setup's input goes to when none is picked: its exact name,
// else the one name matching ignoring case, else by normalized name (the server's rule).
export function matchInput(input: string, columns: string[]): string | null {
  if (columns.includes(input)) return input
  const lower = columns.filter(c => c.toLowerCase() === input.toLowerCase())
  if (lower.length === 1) return lower[0]
  const norm = columns.filter(c => normalized(c) === normalized(input))
  return norm.length === 1 ? norm[0] : null
}

export const stepOf = (steps: SheetSetupStep[], column: string): SheetSetupStep | undefined =>
  steps.find(s => s.columns.includes(column))

// The main columns of `start`'s steps and every step they read from.
export function withUpstream(steps: SheetSetupStep[], start: string[]): string[] {
  const picked = new Set<string>()
  const queue = start.map(c => stepOf(steps, c)).filter((s): s is SheetSetupStep => !!s && !s.problem)
  while (queue.length) {
    const s = queue.shift()!
    if (picked.has(s.column)) continue
    picked.add(s.column)
    for (const read of s.reads) {
      const up = stepOf(steps, read)
      if (up && !up.problem && !picked.has(up.column)) queue.push(up)
    }
  }
  return steps.filter(s => picked.has(s.column)).map(s => s.column)
}
