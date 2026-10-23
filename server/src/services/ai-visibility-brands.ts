// The brands an AI visibility table looks for (yours first): changing them
// rewrites the brand list in each formula the table made (between its marker
// comments, so the columns it reads keep whatever names they have now) and
// works every row out again from the answers already there. Nothing is asked
// again and nothing costs money. A formula a person rewrote without the
// markers is left as it is.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { withBrands } from '../lib/ai-visibility/formulas';
import type { Brands } from '../lib/ai-visibility/input';
import { startFormulaColumn } from './formula-column';
import { sheetFree } from './ai-visibility-columns';
import type { AiVisibilityRecord } from './ai-visibility-run';

export interface BrandsSaved { columns: string[]; problems: string[] }

export async function setAiVisibilityBrands(
  userId: string, rec: AiVisibilityRecord, brands: Brands,
): Promise<BrandsSaved> {
  const list = [brands.brand, ...brands.competitors];
  // A record can outlive its column: only the sheet's own columns are saved again.
  const there = new Set(getSheetColumns(rec.questions_sheet_id, userId));
  const formulas = (db.prepare(`SELECT column_name AS column, formula, description FROM formula_columns
    WHERE sheet_id = ? AND user_id = ? ORDER BY rowid`).all(rec.questions_sheet_id, userId) as
    Array<{ column: string; formula: string; description: string | null }>).filter(f => there.has(f.column));
  const out: BrandsSaved = { columns: [], problems: [] };
  for (const f of formulas) {
    const next = withBrands(f.formula, list);
    if (next === null || next === f.formula) continue;
    const saved = await startFormulaColumn(userId, rec.questions_sheet_id, {
      formula: next, column: f.column, ...(f.description ? { description: f.description } : {}),
    });
    if ('fail' in saved) { out.problems.push(`${f.column}: ${saved.message}`); continue; }
    out.columns.push(f.column);
    if (!(await sheetFree(rec.questions_sheet_id))) out.problems.push(`${f.column} is still filling.`);
  }
  db.prepare(`UPDATE ai_visibility SET brand = ?, competitors = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?`).run(brands.brand, JSON.stringify(brands.competitors), rec.id, userId);
  return out;
}
