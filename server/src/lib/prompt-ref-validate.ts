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
import { getLockedRunColumns } from './run-locked-columns';

// Returns the user-facing error when the prompt references columns that don't
// exist on the sheet or that an active run is still filling, or null when every
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
  const columns = getSheetColumns(sheetId, userId, false);
  const unknown = findUnknownColumnReferences(prompt, columns);
  if (unknown.length > 0) return unknownRefsMessage(unknown);
  // A column another run is still filling holds "⏳ Processing..." on the rows
  // it hasn't reached; reading it fed (and billed) the model that placeholder.
  const locked = getLockedRunColumns(sheetId, userId);
  if (locked.size === 0) return null;
  for (const ref of extractColumnReferences(prompt)) {
    const col = columns.find(c => normalizeColumnName(c) === ref || c.toLowerCase() === ref.toLowerCase());
    if (col && locked.has(col)) {
      return `/${ref} reads "${col}", which a run that hasn't finished is still filling. `
        + 'Wait for that run to finish (or stop it), then start this one.';
    }
  }
  return null;
}
