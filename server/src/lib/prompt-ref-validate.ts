// Shared up-front /column reference gate for AI run start AND preview.
//
// Unknown refs substitute as "[MISSING: /token]" on EVERY row, so a run would
// spend its whole model budget producing garbage. Real incident: "/Company Fit (Output)" typed
// literally matches only "/Company" — the token regex stops at the space —
// and 961 paid calls produced junk before a human noticed. The message carries
// a normalized-name suggestion so the caller fixes the prompt in one step.
// Prompts needing a literal standalone "/word" (rare in prose — URLs,
// fractions, and dates are already excluded by the token regex) reword
// instead; no escape-hatch flag.
import { getSheetColumns } from './sql-helpers';
import { extractColumnReferences, findUnknownColumnReferences, normalizeColumnName, unknownRefsMessage } from './prompt';
import { runHeldColumns } from './run-locked-columns';
import { heldReadWords } from './run-held-words';
import type { HeldRead } from './run-held-reads';

// Returns the user-facing error when the prompt references columns that don't
// exist on the sheet or that a run is still filling (or, stopped, still putting
// its ⏳ cells back to what they held before it), or null when every
// reference resolves to a finished column. Deliberately NO
// allowance for the run's own not-yet-created "(Output)"/"(Data)" columns: if
// they exist from a prior run, getSheetColumns already includes them; if they
// don't, referencing them is exactly the [MISSING]-on-every-row failure this
// gate exists to stop (a synthetic allowance let "/foo_data" pass on a
// run that would never create that column).
export function unknownPromptRefsError(
  sheetId: string,
  userId: string,
  prompt: string,
): string | null {
  return promptRefsRefusal(sheetId, userId, prompt)?.message ?? null;
}

// The same, saying which held column it was (a setup's step waits for it: RunFail.held). own: the columns
// the run writes itself, which its own run holds (a paused run's resume, lib/run-resume-inputs.ts).
export function promptRefsRefusal(
  sheetId: string, userId: string, prompt: string, own: readonly string[] = [],
): { message: string; held?: HeldRead } | null {
  const columns = getSheetColumns(sheetId, userId, false);
  const unknown = findUnknownColumnReferences(prompt, columns);
  if (unknown.length > 0) return { message: unknownRefsMessage(unknown) };
  // A column another run is still filling holds "⏳ Processing..." on the rows
  // it hasn't reached; reading it fed (and billed) the model that placeholder.
  // A stopped or failed run's ⏳ cells stay until its clear reaches them.
  const held = runHeldColumns(sheetId, userId, { clearing: true });
  if (held.size === 0) return null;
  for (const ref of extractColumnReferences(prompt)) {
    const col = columns.find(c => normalizeColumnName(c) === ref || c.toLowerCase() === ref.toLowerCase());
    const hold = col === undefined || own.includes(col) ? undefined : held.get(col);
    if (col === undefined || !hold) continue;
    return { message: heldReadWords(`/${ref}`, col, hold), held: { column: col, hold } };
  }
  return null;
}
