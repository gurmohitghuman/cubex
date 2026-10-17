// Rerun target selection for AI columns. Split out of ai-run-rerun.ts (200-line
// guardrail) so the predicate and its rationale live in one readable place.
//
// Named modes exist because the old implicit default silently meant "every row"
// on a fresh or mostly-empty column: a 10-row error retry once became a
// 9,675-row full-sheet run, caught at row 14 and cancelled.
// Each mode is one predicate over the
// (Output) cell:
//   errored — only ❌ cells (the retry-what-failed case)
//   empty   — only blank cells (never populated, or cleared), and cells an
//             "Only run if" rule left ("⏭️ Condition not met": never run)
//   missing — empty OR ❌ OR still-⏳ (the historical default; the UI's
//             "Run Missing or Errors" button)
//   all     — every row in the sheet. Re-bills the lot.
import { isConditionNotMet } from '../lib/run-markers';
import type { CheckedRule } from '../lib/run-condition';
import { chooseRerunTargets, type RerunScope } from './rerun-targets';

export type AiRerunMode = 'errored' | 'empty' | 'missing' | 'all';

export const AI_RERUN_MODES: readonly AiRerunMode[] = ['errored', 'empty', 'missing', 'all'];

// The historical default, kept so the UI route and existing callers are
// unchanged. Programmatic surfaces (MCP, /api/v1) require an explicit mode.
export const DEFAULT_AI_RERUN_MODE: AiRerunMode = 'missing';

// True when a row holding `value` in its (Output) cell is a target under `mode`.
// Pure — unit-tested in tests/unit/ai-rerun-modes.test.ts.
export function matchesRerunMode(value: string | null, mode: AiRerunMode): boolean {
  if (mode === 'all') return true;
  // `|| ''`, NOT `?? ''`. json_extract returns a real JS number for a numeric
  // cell, so a score of 0 (or false) is FALSY: `||` coerces it to '' and the row
  // counts as empty. That is the historical behavior and changing it here would
  // silently alter which rows a 'missing' rerun targets for existing users.
  // Whether a 0-score cell SHOULD count as empty is a separate product question
  // — deliberately not decided inside a refactor.
  const v = (value || '').toString();
  const isEmpty = v.trim() === '' || isConditionNotMet(v);
  // The worker writes '❌ Error: …' on a failed row and '⏳ Processing...' while
  // in flight; both are sentinels, not user data.
  const isErrored = v.startsWith('❌');
  const isProcessing = v.includes('⏳');
  switch (mode) {
    case 'errored': return isErrored;
    case 'empty': return isEmpty;
    case 'missing': return isEmpty || isErrored || isProcessing;
  }
}

// Resolve the row_index values a rerun should target under `mode` (among the
// first rows or the rows `scope` names, when it does; its explicit rows win).
// 'all' still reads the rows (not a bare count) so the caller gets real
// indexes that exist right now. Paged (rerun-targets.ts): call it inside the
// start's busy window, so no sort moves the rows between choosing them and
// seeding them.
// keptOut: the column's rule, when a setup carries it on (rerun-targets.ts).
export function resolveRerunTargets(
  sheetId: string, userId: string, outputColumn: string, mode: AiRerunMode, scope: RerunScope = {},
  keptOut: CheckedRule | null = null,
): Promise<number[]> {
  return chooseRerunTargets(sheetId, userId, outputColumn, v => matchesRerunMode(v as string | null, mode), scope,
    keptOut);
}
