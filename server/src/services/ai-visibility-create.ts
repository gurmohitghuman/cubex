// An AI visibility table: one implementation for the app, /api/v1 and MCP. A
// new table "AI visibility for <brand>" with a Questions sheet (the questions,
// one enrichment column per engine set up and not run, the free formula
// columns that read the answers) and a Cited sites sheet (the sources each
// answer cites, with their domain). Nothing that costs money runs: asking the
// engines takes the person's click or an agent's run (services/ai-visibility-run.ts).
// The engine configs are checked against treg's catalog first, then the
// table, sheets, rows, engine columns and record go in one transaction, then
// the free columns through their own services. Its History opens with "Made
// the AI visibility table". It is an ordinary table: deleting it puts it in the trash.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { appendColumnsToOrder } from '../lib/sql-helpers';
import { createSheetTxn } from '../lib/sheet-crud-helpers';
import { logSheetChange, withoutChangeLog } from '../lib/change-log';
import { MAX_COLUMNS_PER_SHEET, MAX_ROWS_PER_SHEET } from '../lib/constants';
import { QUESTION_COLUMN, SITE_COLUMNS } from '../lib/ai-visibility/engines';
import type { AiVisibilityInput } from '../lib/ai-visibility/input';
import { createTable } from './table-crud';
import { appendRows } from './rows-write';
import { buildEngines, writeEngines, type BuiltEngine } from './ai-visibility-engines';
import { addFreeColumns, type Sheets } from './ai-visibility-columns';
import type { RunFail } from './run-shared';

export interface AiVisibilityTable {
  id: string; tableId: string; tableName: string; questionsSheetId: string; sitesSheetId: string;
  questions: number; engines: string[];
  problems: string[];   // a free step that didn't finish; the table is there all the same
}

const QUESTIONS_SHEET = 'Questions';
const SITES_SHEET = 'Cited sites';
const QUESTIONS_WORDS = 'The questions buyers ask, each put to the AI engines. Each engine column holds its answer; '
  + 'the formula columns say whether it names you, and where.';
const SITES_WORDS = 'Every source the engines cited, one row each, with the question and the engine it came from.';

// "AI visibility for <brand>" (without what table names can't hold), or "… 2", 3…
// when a live table has the name.
function freeTableName(userId: string, brand: string): string {
  const shown = brand.replace(/[<>"]/g, '').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
  const base = shown ? `AI visibility for ${shown}` : 'AI visibility';
  const taken = db.prepare('SELECT 1 FROM tables WHERE user_id = ? AND name = ? AND trash_id IS NULL LIMIT 1');
  let name = base;
  for (let n = 2; taken.get(userId, name); n++) name = `${base} ${n}`;
  return name;
}

// Why the table can't be made under this Cubex's sheet caps, or null.
export function aiVisibilityCapProblem(input: AiVisibilityInput, maxColumns = MAX_COLUMNS_PER_SHEET,
  maxRows = MAX_ROWS_PER_SHEET): string | null {
  const columns = 3 + input.engines.length * 3;
  if (maxColumns < Math.max(columns, Object.keys(SITE_COLUMNS).length)) {
    return `The questions sheet needs ${columns} columns, but this Cubex allows ${maxColumns} per sheet.`;
  }
  return maxRows < input.questions.length
    ? `This Cubex allows ${maxRows} rows per sheet, fewer than the questions.` : null;
}

type Made = { id: string; tableId: string; tableName: string } & Sheets;
function makeTable(userId: string, input: AiVisibilityInput, built: BuiltEngine[]): Made | RunFail {
  return db.transaction((): Made | RunFail => {
    const made = withoutChangeLog(() => createTable(userId, freeTableName(userId, input.brand)));
    if ('fail' in made) return { fail: 'bad_request', message: made.message };
    const { id: tableId, name: tableName, sheetId: questions } = made.ok;
    logSheetChange(questions, userId, 'ai_visibility_created',
      `Made the AI visibility table for ${input.brand}: ${input.questions.length} questions, `
      + `${input.engines.length} engines`, { detail: { questions: input.questions.length, engines: input.engines } });
    db.prepare('UPDATE sheets SET name = ?, description = ? WHERE id = ? AND user_id = ?')
      .run(QUESTIONS_SHEET, QUESTIONS_WORDS, questions, userId);
    appendColumnsToOrder(questions, userId, [QUESTION_COLUMN]);
    const rows = appendRows(questions, userId, input.questions.map(q => ({ [QUESTION_COLUMN]: q })));
    if ('fail' in rows) throw new Error(`The questions didn't go in: ${rows.fail}`);
    const sheet = createSheetTxn(tableId, userId, SITES_SHEET, questions, { seed: false });
    if (!sheet.ok) throw new Error('The sites sheet could not be made.');
    const sites = sheet.sheetId;
    db.prepare('UPDATE sheets SET description = ? WHERE id = ? AND user_id = ?').run(SITES_WORDS, sites, userId);
    writeEngines(userId, questions, sites, built);
    const id = uuidv4();
    db.prepare(`INSERT INTO ai_visibility (id, user_id, table_id, questions_sheet_id, sites_sheet_id, brand,
        competitors, domain, country, engines) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, tableId, questions, sites, input.brand, JSON.stringify(input.competitors), input.domain,
        input.country, JSON.stringify(input.engines));
    return { id, tableId, tableName, questions, sites };
  }).immediate();
}

export async function createAiVisibilityTable(
  userId: string, input: AiVisibilityInput,
): Promise<{ ok: AiVisibilityTable } | RunFail> {
  const capped = aiVisibilityCapProblem(input);
  if (capped) return { fail: 'bad_request', message: capped };
  const built = await buildEngines(input.engines, input.country, input.questions.length);
  if ('fail' in built) return built;
  const made = makeTable(userId, input, built.ok);
  if ('fail' in made) return made;
  const problems: string[] = [];
  await withoutChangeLog(() => addFreeColumns(userId, made, input, problems)).catch((e: Error) => {
    problems.push(`Setting up the columns stopped: ${e.message}`);
  });
  for (const p of problems) console.error(`AI visibility table ${made.tableId}: ${p}`);
  return {
    ok: {
      id: made.id, tableId: made.tableId, tableName: made.tableName, questionsSheetId: made.questions,
      sitesSheetId: made.sites, questions: input.questions.length, engines: input.engines, problems,
    },
  };
}
