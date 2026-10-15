// A duplicate check: what removing duplicates would do, changing nothing (the
// app's dialog, an agent's dry run). It reads under a read hold
// (lib/sheet-busy.ts), so no sort or import moves rows under it while cell
// edits go on. A newer check of the same sheet, a removal, or the asker going
// away stops it, so a dialog changing its options never stacks up scans.
// Its answer names a run holding the sheet (sheetRunBlock); when that is an
// auto-run run, the sheet yields for a moment as it does for a refused removal,
// since a removal is likely next.
import { getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import { withSheetRead } from '../lib/sheet-busy';
import { sheetRunBlock, type RunBlock } from './autorun-block';
import { DEDUPE_RUN_ACTIVE, parseDedupeRequest, type DedupeArgs } from './dedupe-input';
import { dedupeReport, type DedupeReport } from './dedupe-report';
import { scanDuplicates } from './dedupe-scan';
import type { RunFail } from './run-shared';

// blockedBy: the run that would refuse a removal now, so the dialog can say so up front.
export interface DedupeCheck extends DedupeReport { blockedBy: RunBlock | null }

const checks = new Map<string, { stop: () => void; done: Promise<unknown> }>();

// Stops the sheet's checks in progress, then calls `next` in the same turn
// it sees none: anything awaited in between would let a waiting check start
// first (two checks that waited on one older check both wake). A check starts
// its read and registers itself together, so "none in the map" means none runs.
export async function afterDuplicateChecks<T>(sheetId: string, next: () => T): Promise<T> {
  for (let check = checks.get(sheetId); check; check = checks.get(sheetId)) {
    check.stop();
    await check.done.catch(() => {});
    if (checks.get(sheetId) === check) checks.delete(sheetId);
  }
  return next();
}

const STOPPED = 'This check was stopped: a newer one, or a removal, started.';

export async function checkDuplicates(
  userId: string, sheetId: string, args: DedupeArgs, signal?: AbortSignal,
): Promise<{ ok: DedupeCheck } | RunFail> {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const parsed = parseDedupeRequest(getSheetColumns(sheetId, userId, false), args);
  if ('fail' in parsed) return parsed;
  const req = parsed.ok;
  // Listening from the start: the asker may leave while an older check stops.
  const stopper = new AbortController();
  const stop = () => stopper.abort();
  if (signal?.aborted) stop();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const entry = await afterDuplicateChecks(sheetId, () => {
      if (stopper.signal.aborted) return null;
      const done = withSheetRead(sheetId, async () => {
        const found = await scanDuplicates(sheetId, userId, req, { signal: stopper.signal });
        return found && dedupeReport(sheetId, userId, req, found);
      }, 'checking for duplicates');
      const started = { stop, done };
      checks.set(sheetId, started);
      return started;
    });
    if (!entry) return { fail: 'conflict', message: STOPPED };
    const { done } = entry;
    try {
      const out = await done;
      if (out && 'busy' in out) return { fail: 'conflict', message: out.busy };
      if (!out) return { fail: 'conflict', message: STOPPED };
      return { ok: { ...out, blockedBy: sheetRunBlock(sheetId, userId, DEDUPE_RUN_ACTIVE) } };
    } finally {
      if (checks.get(sheetId) === entry) checks.delete(sheetId);
    }
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}
