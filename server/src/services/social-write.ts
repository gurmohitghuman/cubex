// Inside a social research table's create transaction (services/social-create.ts):
// each run column written as set up and never run (setup_only 2, as an AI
// visibility table's engines), so its column menu, Run columns and agents run
// it with this setup; a Posts sheet's formulas, filled already (it has no rows)
// and following its columns; and its Top posts view. Each throws on a problem,
// rolling the whole create back.
import { getSheetColumns } from '../lib/sql-helpers';
import { withoutChangeLog } from '../lib/change-log';
import type { EnrichRunConfig } from '../lib/enrich-run-config';
import type { WhereItem } from '../lib/row-filter/where';
import { COMMENT_COLUMNS as C, POST_COLUMNS as P, REACTION_PROMPT, STEP_COLUMNS as S, breakdownPrompt }
  from '../lib/social/names';
import type { PlatformSpec } from '../lib/social/platforms';
import { applyListStart, planListStart } from './enrich-list-start';
import { writeAiSetup, writeFormulaSetup, writeHttpSetup } from './setup-version-write';
import { startRunRule } from './run-rule';
import { createView } from './views';
import type { BuiltRun } from './social-steps';

export const BREAKDOWN_STATUS = `${S.breakdown} (Status)`;
export const BREAKDOWN_OUTPUTS = [S.hook, S.tension, S.payoff, S.why];
export const REACTION_OUTPUT = `${C.reaction} (Output)`;
export const TOP_POSTS_VIEW = 'Top posts';

function withRule(sheetId: string, userId: string, run: BuiltRun, what: string): EnrichRunConfig {
  const rule = startRunRule(sheetId, userId, run.input.runIf);
  if ('fail' in rule) throw new Error(`${what}: ${rule.message}`);
  return rule.ok ? { ...run.config, runIf: rule.ok.rule } : run.config;
}

// A list column on `sheetId` adding rows to `destSheetId`, set up and not run.
export function writeListColumn(userId: string, sheetId: string, destSheetId: string, run: BuiltRun, what: string) {
  const input = { ...run.input, list: { ...run.input.list!, dest: { sheetId: destSheetId } } };
  const plan = planListStart(userId, sheetId, input, run.config, getSheetColumns(sheetId, userId));
  if ('fail' in plan || !plan.ok) throw new Error(`${what}: ${'fail' in plan ? plan.message : 'no list'}`);
  const dest = applyListStart(userId, sheetId, run.input.columnName, plan.ok, run.config);
  if ('raced' in dest) throw new Error(`${what}: ${dest.raced}`);
  writeHttpSetup(sheetId, userId, run.input.columnName, {
    kind: 'http', mode: 'enrichment', config: withRule(sheetId, userId, run, what), allowSecrets: 0,
    destSheetId: dest.destSheetId, extracted: [],
  }, getSheetColumns(sheetId, userId), false, 2);
}

// An enrichment answering once a row (a transcript, a creator), filling its output columns.
export function writeStepColumn(userId: string, sheetId: string, run: BuiltRun, what: string) {
  writeHttpSetup(sheetId, userId, run.input.columnName, {
    kind: 'http', mode: 'enrichment', config: withRule(sheetId, userId, run, what), allowSecrets: 0,
    destSheetId: null, extracted: run.input.outputs.map(o => o.columnName),
  }, getSheetColumns(sheetId, userId), false, 2);
}

// An AI column with no model yet: its run asks for one (the sheet's or the account's default, or a pick).
const aiFill = (prompt: string, outputs: string[] | null) => ({
  kind: 'ai' as const, prompt, systemPrompt: null, model: null, temperature: null, maxChars: null,
  concurrency: null, webSearch: false, webFetch: false, dataColumn: null, searchEngine: null, searchMode: null,
  maxSearchesPerRow: null, searchEngineUsed: null, runIf: null,
  outputColumns: outputs ? outputs.map(c => ({ columnName: c, type: 'string' as const, description: '' })) : null,
});

// withTranscript: the transcript step is set up on this sheet too, so the prompt can read Transcript text.
export function writeBreakdown(userId: string, sheetId: string, spec: PlatformSpec, withTranscript: boolean) {
  writeAiSetup(sheetId, userId, BREAKDOWN_STATUS, aiFill(breakdownPrompt(spec.label, withTranscript),
    BREAKDOWN_OUTPUTS), 2);
}

export function writeReaction(userId: string, commentsSheetId: string) {
  writeAiSetup(commentsSheetId, userId, REACTION_OUTPUT, aiFill(REACTION_PROMPT, null), 2);
}

export function writeFormulas(userId: string, sheetId: string, spec: PlatformSpec) {
  for (const f of spec.formulas) {
    writeFormulaSetup(sheetId, userId, f.column, { kind: 'formula', formula: f.formula, description: null }, true,
      getSheetColumns(sheetId, userId));
  }
}

// The day a post must be posted on or after for Top posts, from a day ("2026-11-24") and how many days back.
export const sinceDay = (today: string, days: number): string =>
  new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

export function topPostsWhere(f: { minViews: number | null; minComments: number | null; since: string | null },
  columns: string[]): WhereItem[] {
  const where: WhereItem[] = [];
  if (f.minViews !== null) where.push({ column: P.views, operator: 'gte', value: String(f.minViews) });
  if (f.minComments !== null && columns.includes(P.comments)) {
    where.push({ column: P.comments, operator: 'gte', value: String(f.minComments) });
  }
  if (f.since !== null) where.push({ column: P.posted, operator: 'date_gte', value: f.since });
  return where;
}

// The Top posts view, made the sheet's view, when the table has filters.
export function writeTopPosts(userId: string, sheetId: string, where: WhereItem[]) {
  if (where.length === 0) return;
  const made = withoutChangeLog(() => createView(sheetId, userId, {
    name: TOP_POSTS_VIEW, description: 'The posts that pass the table\'s filters: run the steps on these.', where,
    activate: true,
  }));
  if ('fail' in made) throw new Error(`The ${TOP_POSTS_VIEW} view: ${made.message}`);
}
