// Parse a run's `target_rows` column (JSON array of row indices, set only for
// reruns; NULL for full runs). Shared by the AI and HTTP resume paths so a
// paused rerun re-dispatches as a RERUN — without this, resume falls back to a
// full-sheet run, overwriting the whole column and re-spending on every row.
//
// Returns null for full runs, malformed JSON, or anything that isn't a
// non-empty array of non-negative integers — callers fall back to a full run.
export function parseTargetRows(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    if (!parsed.every(v => typeof v === 'number' && Number.isInteger(v) && v >= 0)) return null;
    return parsed as number[];
  } catch {
    return null;
  }
}
