// Setups in the app (pure): which of a sheet's filled columns a chosen one
// brings with it. A step reads columns; the step that made a column it reads
// comes too, down the chain (the server's include-upstream rule, so the
// dialog can show the ticks before saving). A step that can't be saved
// (problem) never comes; what it made stays an input.
import type { SheetSetupStep } from '@/utils/api/setups'

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
