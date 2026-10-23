// An AI visibility table's free columns, words and views, once its sheets and
// engine columns are there (services/ai-visibility-create.ts): on the
// questions sheet each engine's "You in <engine>", "Named by" and "Named
// first" (formulas that follow the answers as they come); on the sites sheet
// the cited site's domain (a clean column) and "Your site" (a formula). Each
// one holds its sheet busy while it fills, so the next waits for it.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { sheetBusyWith } from '../lib/sheet-busy';
import { writeColumnDescription } from '../lib/column-descriptions';
import { SAMPLE_STEP_POLL_MS, SAMPLE_STEP_WAIT_MS } from '../lib/constants';
import {
  NAMED_BY_COLUMN, NAMED_FIRST_COLUMN, QUESTION_COLUMN, SITE_COLUMNS, engineById, engineColumns, type EngineSpec,
} from '../lib/ai-visibility/engines';
import { namedByFormula, namedFirstFormula, youFormula, yourSiteFormula } from '../lib/ai-visibility/formulas';
import type { AiVisibilityInput } from '../lib/ai-visibility/input';
import { startFormulaColumn } from './formula-column';
import { startCleanColumn } from './clean-column';
import { createView } from './views';
import { reorderSheetColumns } from './column-reorder';

export interface Sheets { questions: string; sites: string }

// Waits for the fill before to let go of the sheet; false when it's still going.
export async function sheetFree(sheetId: string): Promise<boolean> {
  for (const until = Date.now() + SAMPLE_STEP_WAIT_MS; sheetBusyWith(sheetId);) {
    if (Date.now() > until) return false;
    await new Promise(resolve => setTimeout(resolve, SAMPLE_STEP_POLL_MS));
  }
  return true;
}

// The words each column says about itself (column descriptions are data for
// whoever reads the sheet next, never added to a prompt).
export function columnWords(input: AiVisibilityInput, engines: EngineSpec[]): Record<string, Record<string, string>> {
  const questions: Record<string, string> = {
    [QUESTION_COLUMN]: 'A question as a buyer would ask it. Add rows to ask more.',
    [NAMED_BY_COLUMN]: 'How many of the engines that answered name your brand.',
    [NAMED_FIRST_COLUMN]: 'The brand most engines name first in their answer (of the brands this table looks for).',
  };
  for (const e of engines) {
    const c = engineColumns(e);
    questions[c.status] = `${e.name}, asked from ${input.country}. The sites its answer cites are rows in Cited sites.`;
    questions[c.answer] = `What ${e.name} answered.`;
    questions[c.you] = `Where ${e.name}'s answer first names your brand among the brands this table looks for `
      + '("1st of 4"), or Not named.';
  }
  const sites: Record<string, string> = {
    [SITE_COLUMNS.question]: 'The question whose answer cited this site.',
    [SITE_COLUMNS.engine]: 'The engine that cited it.',
    [SITE_COLUMNS.position]: 'Its place among the sources the answer listed.',
    [SITE_COLUMNS.domain]: "The site's domain. Its value counts show which sites AI cites most.",
    [SITE_COLUMNS.yours]: `Yes when the source is on your site${input.domain ? ` (${input.domain})` : ''}.`,
  };
  return { questions, sites };
}

function describe(sheetId: string, userId: string, words: Record<string, string>, columns: string[]) {
  db.transaction(() => {
    for (const c of columns) if (words[c]) writeColumnDescription(sheetId, userId, c, words[c]);
    db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?`).run(sheetId, userId);
  }).immediate();
}

// One free column, then the wait for its fill; a problem is said, never thrown.
async function step(
  sheetId: string, label: string, problems: string[], start: () => Promise<{ ok: unknown } | { message: string }>,
): Promise<boolean> {
  const r = await start();
  if (!('ok' in r)) { problems.push(`${label} didn't start: ${r.message}`); return false; }
  if (!(await sheetFree(sheetId))) problems.push(`${label} is still filling.`);
  return true;
}

export async function addFreeColumns(
  userId: string, sheets: Sheets, input: AiVisibilityInput, problems: string[],
): Promise<void> {
  const engines = input.engines.map(id => engineById(id)!);
  const brands = [input.brand, ...input.competitors];
  const words = columnWords(input, engines);
  const q = sheets.questions;
  for (const e of engines) {
    const c = engineColumns(e);
    await step(q, c.you, problems, () => startFormulaColumn(userId, q, { formula: youFormula(c.answer, brands),
      column: c.you }));
  }
  await step(q, NAMED_BY_COLUMN, problems, () => startFormulaColumn(userId, q, {
    formula: namedByFormula(engines.map(e => engineColumns(e).answer), brands), column: NAMED_BY_COLUMN,
  }));
  await step(q, NAMED_FIRST_COLUMN, problems, () => startFormulaColumn(userId, q, {
    formula: namedFirstFormula(engines.map(e => engineColumns(e).answer), brands), column: NAMED_FIRST_COLUMN,
  }));
  const s = sheets.sites;
  await step(s, SITE_COLUMNS.domain, problems, () => startCleanColumn(userId, s, {
    source: SITE_COLUMNS.url, cleaner: 'domain', column: SITE_COLUMNS.domain,
  }));
  if (input.domain) {
    await step(s, SITE_COLUMNS.yours, problems, () => startFormulaColumn(userId, s, {
      formula: yourSiteFormula(SITE_COLUMNS.domain, input.domain), column: SITE_COLUMNS.yours,
    }));
  }

  const order = [QUESTION_COLUMN, NAMED_BY_COLUMN, NAMED_FIRST_COLUMN,
    ...engines.flatMap(e => Object.values(engineColumns(e)))];
  const plans: Array<[string, string[], Record<string, string>]> =
    [[q, order, words.questions], [s, Object.values(SITE_COLUMNS), words.sites]];
  for (const [sheet, wanted, w] of plans) {
    // Only the columns there (a step that didn't start, Position for Perplexity alone), the rest after them.
    const there = getSheetColumns(sheet, userId);
    const cols = [...wanted.filter(c => there.includes(c)), ...there.filter(c => !wanted.includes(c))];
    describe(sheet, userId, w, cols);
    const placed = reorderSheetColumns(sheet, userId, cols, { bumpDataVersion: true });
    if ('fail' in placed) problems.push(`The columns couldn't be put in order: ${placed.error}`);
  }
  addViews(userId, sheets, input, problems);
}

function addViews(userId: string, sheets: Sheets, input: AiVisibilityInput, problems: string[]) {
  const views = [
    createView(sheets.questions, userId, {
      name: 'Not named anywhere', description: 'Questions where no engine that answered names your brand.',
      where: [{ column: NAMED_BY_COLUMN, operator: 'starts_with', value: '0 of' }], hidden_columns: null,
    }),
    ...(input.domain ? [createView(sheets.sites, userId, {
      name: 'Your site', description: 'Sources on your own site.',
      where: [{ column: SITE_COLUMNS.yours, operator: 'eq', value: 'Yes' }], hidden_columns: null,
    })] : []),
  ];
  for (const v of views) if ('fail' in v) problems.push(`A view wasn't made: ${v.message}`);
}
