// A lookup step checked against the sheet it looks in (a pure read, so an
// estimate checks what a start would): another sheet of the account, never
// this one; the column it matches and the one it returns, both in that sheet
// (names resolved as inputs are: another case, a normalized form); and the
// input whose value it looks for. What "answered by" shows by default: that
// sheet's name.
import { db } from '../lib/db';
import { getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import { resolveColumn } from '../lib/waterfall/inputs';
import type { LookupChoices, WaterfallRunConfig } from '../lib/waterfall/config';
import type { RunFail } from './run-shared';

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

// The sheet a lookup step looks in: its name, or why it can't be looked in. A
// sheet the account still holds that the reads pass over is in the trash
// (hidden, and it can come back); one it no longer holds was deleted for good.
export function lookedInSheet(sheetId: string, userId: string): { name: string } | { gone: string } {
  const name = db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ?').pluck()
    .get(sheetId, userId) as string | undefined;
  if (name === undefined) return { gone: 'the sheet it looks in was deleted' };
  if (!verifySheetOwnership(sheetId, userId)) return { gone: `the sheet "${name}" it looks in is in the trash` };
  return { name };
}

export function buildLookupStep(
  where: string, c: LookupChoices, ctx: { userId: string; sheetId: string }, inputKeys: readonly string[],
): { ok: { choices: LookupChoices; sheetName: string } } | RunFail {
  if (c.sheetId === ctx.sheetId) return bad(`${where}: a lookup looks in another sheet, never its own.`);
  const sheet = lookedInSheet(c.sheetId, ctx.userId);
  if ('gone' in sheet) return bad(`${where}: ${sheet.gone}.`);
  const sheetName = sheet.name;
  const columns = getSheetColumns(c.sheetId, ctx.userId, false);
  const matchColumn = resolveColumn(c.matchColumn, columns);
  const returnColumn = resolveColumn(c.returnColumn, columns);
  const missing = !matchColumn ? c.matchColumn : !returnColumn ? c.returnColumn : null;
  if (missing !== null) return bad(`${where}: "${missing}" isn't a column of "${sheetName}".`);
  if (!inputKeys.includes(c.inputKey)) return bad(`${where}: "${c.inputKey}" isn't one of the waterfall's inputs.`);
  return { ok: { choices: { ...c, matchColumn: matchColumn!, returnColumn: returnColumn! }, sheetName } };
}

// Inside a start's insert transaction: whether a lookup step's sheet or columns
// changed since it was built (a rename there rewrote the column's newest run,
// not this one about to be), so the start is tried again.
export function lookupStepsMoved(config: WaterfallRunConfig, userId: string): boolean {
  return config.waterfall.steps.some(({ choices: c }) => {
    if (c.kind !== 'lookup') return false;
    if (!verifySheetOwnership(c.sheetId, userId)) return true;
    const columns = getSheetColumns(c.sheetId, userId, false);
    return !columns.includes(c.matchColumn) || !columns.includes(c.returnColumn);
  });
}

export const LOOKUP_MOVED = 'A column a lookup step reads was just renamed or deleted. Try again.';
