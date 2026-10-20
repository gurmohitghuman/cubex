// An AI visibility table's engine columns: one enrichment column per engine
// on the questions sheet, set up and not run. Each config is built as a run
// start builds it (checked against treg's catalog: the tool, its inputs, the
// answer output, the sources list), then written as a setup-only run
// (migration 043, services/setup-version-write.ts), so the column's Edit,
// its column-menu reruns and its auto-run all take it up; nothing is called
// or billed until the person asks. The answer text fills "<engine> answer";
// the cited sources become rows of the sites sheet, with the question and the
// engine's name.
import { appendColumnsToOrder, getSheetColumns } from '../lib/sql-helpers';
import type { EnrichRunConfig } from '../lib/enrich-run-config';
import type { EnrichRunInput } from '../lib/enrich-run-input';
import { AI_VISIBILITY_SOURCES_PER_ROW } from '../lib/constants';
import {
  QUESTION_COLUMN, SITE_COLUMNS, engineById, engineColumns, type EngineId, type EngineSpec,
} from '../lib/ai-visibility/engines';
import { buildEnrichmentConfig } from './enrich-run-build';
import { applyListStart, planListStart } from './enrich-list-start';
import { writeHttpSetup } from './setup-version-write';
import type { RunFail } from './run-shared';

export interface BuiltEngine { engine: EngineSpec; input: EnrichRunInput; config: EnrichRunConfig }

function engineInput(e: EngineSpec, country: string, sitesSheetId: string): EnrichRunInput {
  const c = engineColumns(e);
  const fields = [
    ...(e.fields.position ? [{ path: e.fields.position, columnName: SITE_COLUMNS.position }] : []),
    { path: e.fields.title, columnName: SITE_COLUMNS.title }, { path: e.fields.url, columnName: SITE_COLUMNS.url },
  ];
  return {
    toolId: e.toolId, preset: null, columnName: c.status, continueColumn: false,
    inputs: { [e.questionInput]: { column: QUESTION_COLUMN }, [e.countryInput]: { value: country } },
    cleanDomains: false, providerOrder: [], skipProviders: [], stopAtFirst: false, email: null,
    outputs: [{ key: 'answer', path: e.answerPath, columnName: c.answer }],
    rows: { mode: 'all', status: 'any', test: null, rowIndexes: null },
    conditions: [], runIf: null, maxCostPerRowUsd: null, spendLimitUsd: null, concurrency: null,
    // Answers change from one ask to the next: every run asks again (no reuse, nor treg's archive).
    fresh: true, rowGeneration: null,
    list: {
      dest: { sheetId: sitesSheetId }, provider: e.provider, maxItems: AI_VISIBILITY_SOURCES_PER_ROW, fields,
      copy: [
        { from: QUESTION_COLUMN, to: SITE_COLUMNS.question }, { from: '', to: SITE_COLUMNS.engine, value: e.name },
      ],
      dedupePath: null, ...(e.namesSources ? { itemsPath: e.sourcesPath } : {}),
    },
  };
}

// Every engine's config, before anything is made (the sites sheet isn't there
// yet: its id is set when the columns are written). A tool treg no longer
// serves as the table expects refuses the whole table.
export async function buildEngines(
  engines: readonly EngineId[], country: string, questions: number,
): Promise<{ ok: BuiltEngine[] } | RunFail> {
  const built: BuiltEngine[] = [];
  for (const id of engines) {
    const engine = engineById(id)!;
    const input = engineInput(engine, country, '');
    const config = await buildEnrichmentConfig(input, [QUESTION_COLUMN], questions);
    if ('fail' in config) return { fail: config.fail, message: `${engine.name}: ${config.message}` };
    built.push({ engine, input, config: config.ok });
  }
  return { ok: built };
}

// Inside the create transaction: each engine's columns and setup-only run.
// Throws (rolling the table back) when a sheet changed under it.
export function writeEngines(userId: string, questionsSheetId: string, sitesSheetId: string, built: BuiltEngine[]) {
  for (const b of built) {
    const c = engineColumns(b.engine);
    const input: EnrichRunInput = { ...b.input, list: { ...b.input.list!, dest: { sheetId: sitesSheetId } } };
    const plan = planListStart(userId, questionsSheetId, input, b.config, getSheetColumns(questionsSheetId, userId));
    if ('fail' in plan || !plan.ok) throw new Error(`${b.engine.name}: ${'fail' in plan ? plan.message : 'no list'}`);
    const dest = applyListStart(userId, questionsSheetId, c.status, plan.ok, b.config);
    if ('raced' in dest) throw new Error(`${b.engine.name}: ${dest.raced}`);
    appendColumnsToOrder(questionsSheetId, userId, [c.status, c.answer]);
    writeHttpSetup(questionsSheetId, userId, c.status, {
      kind: 'http', mode: 'enrichment', config: b.config, allowSecrets: 0, destSheetId: dest.destSheetId,
      extracted: [c.answer],
    }, getSheetColumns(questionsSheetId, userId), false, 2);
  }
}
