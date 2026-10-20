// The columns a check adds to an AI visibility table's questions sheet
// (services/ai-visibility-check.ts): "Named by on <date>", a lookup of that
// day's Named by in the dated copy (matched by question, so new and reordered
// questions line up), and "Change since <date>", a formula counting the
// engines that name you now from the answers themselves (a formula column
// never follows another formula column) against that count. Both go right
// after Named by, newest check first, with words saying what they hold. A
// problem is said, never thrown: the asking still goes on.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { writeColumnDescription } from '../lib/column-descriptions';
import { changeFormula } from '../lib/ai-visibility/formulas';
import { ENGINES, NAMED_BY_COLUMN, QUESTION_COLUMN } from '../lib/ai-visibility/engines';
import { newestColumnRun } from './enrich-column';
import { startLookupColumn } from './lookup-column';
import { startFormulaColumn } from './formula-column';
import { reorderSheetColumns } from './column-reorder';
import { describeSheet } from './descriptions';
import { sheetFree } from './ai-visibility-columns';
import { engineColumnsOf, type AiVisibilityRecord } from './ai-visibility-run';
import { brandsOf, type CheckRow } from './ai-visibility-check-store';

// Each engine's answer column, as its run maps the answer (a rename follows).
export function answerColumnsOf(userId: string, sheetId: string): string[] {
  const out: string[] = [];
  for (const column of engineColumnsOf(userId, sheetId)) {
    const run = newestColumnRun(sheetId, userId, column);
    const spec = ENGINES.find(e => e.toolId === run?.config.enrichment.toolId);
    const answer = run?.config.responseMapping.find(m => m.jsonPath === spec?.answerPath)?.columnName;
    if (answer) out.push(answer);
  }
  return out;
}

export const competitorsOf = (rec: AiVisibilityRecord): string[] => {
  try { const v = JSON.parse(rec.competitors); return Array.isArray(v) ? v : []; } catch { return []; }
};

export async function addComparison(
  userId: string, rec: AiVisibilityRecord, c: CheckRow & { questions_copy_id: string },
): Promise<string[]> {
  const q = rec.questions_sheet_id;
  const problems: string[] = [];
  describeCopies(userId, c);
  if (!getSheetColumns(q, userId).includes(c.named_by_column)) {
    await sheetFree(q);
    const made = await startLookupColumn(userId, q, {
      column: c.named_by_column, sourceColumn: QUESTION_COLUMN, otherSheetId: c.questions_copy_id,
      matchColumn: QUESTION_COLUMN, match: 'equals', returns: 'value', returnColumn: NAMED_BY_COLUMN,
    });
    if ('fail' in made) problems.push(`"${c.named_by_column}" wasn't added: ${made.message}`);
    await sheetFree(q);
  }
  if (!getSheetColumns(q, userId).includes(c.change_column)) {
    // Free first: after a restart, the lookup's fill may still hold the sheet.
    await sheetFree(q);
    const answers = answerColumnsOf(userId, q);
    const formula = changeFormula(answers, c.named_by_column, brandsThen(rec, c));
    const made = await startFormulaColumn(userId, q, { column: c.change_column, formula });
    if ('fail' in made) problems.push(`"${c.change_column}" wasn't added: ${made.message}`);
    await sheetFree(q);
  }
  placeAndDescribe(userId, q, c, brandsThen(rec, c), problems);
  return problems;
}

// The brands looked for that day, as the check kept them (the record's now, for a check without them).
const brandsThen = (rec: AiVisibilityRecord, c: CheckRow): string[] =>
  (brandsOf(c).length ? brandsOf(c) : [rec.brand, ...competitorsOf(rec)]);

// Change since, then that day's Named by, right after Named by.
function placeAndDescribe(userId: string, sheetId: string, c: CheckRow, brands: string[], problems: string[]): void {
  const columns = getSheetColumns(sheetId, userId);
  const added = [c.change_column, c.named_by_column].filter(n => columns.includes(n));
  const rest = columns.filter(n => !added.includes(n));
  const at = rest.indexOf(NAMED_BY_COLUMN) + 1;
  const placed = reorderSheetColumns(sheetId, userId, [...rest.slice(0, at), ...added, ...rest.slice(at)],
    { bumpDataVersion: true });
  if ('fail' in placed) problems.push(`The new columns couldn't be put after "${NAMED_BY_COLUMN}": ${placed.error}`);
  db.transaction(() => {
    if (columns.includes(c.named_by_column)) {
      writeColumnDescription(sheetId, userId, c.named_by_column,
        `How many engines named your brand in the answers of ${c.label}, kept in "${c.questions_copy_name}".`);
    }
    if (columns.includes(c.change_column)) {
      writeColumnDescription(sheetId, userId, c.change_column, `How many more (Up) or fewer (Down) engines name `
        + `${brands[0]} now than on ${c.label}, among the brands looked for then (${brands.join(', ')}); blank while `
        + 'a different number of engines has answered than then (still answering, one failed or was added); New: '
        + 'the question had no answers then. One question moving can be chance.');
    }
  }).immediate();
}

function describeCopies(userId: string, c: CheckRow): void {
  const words = (what: string) => `${what} as they were on ${c.label}, kept when the table was checked again on `
    + `${c.created_at.slice(0, 10)}. Nothing fills these columns.`;
  if (c.questions_copy_id) describeSheet(c.questions_copy_id, userId, words('The questions and answers'));
  if (c.sites_copy_id) describeSheet(c.sites_copy_id, userId, words('The sites the answers cited'));
}
