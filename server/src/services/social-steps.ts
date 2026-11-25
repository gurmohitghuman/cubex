// A social research table's runs as their starts take them, built against
// treg's catalog before the table is made (services/social-create.ts): each
// platform's search (a list into its Posts sheet, kept, First seen set by each
// Find posts), and the steps chosen on its Posts sheet: the transcript and the
// creator (one answer a row) and comments (a list into Comments, kept). None
// of them runs here. A platform whose search Cubex can't add rows from now
// (addsRows) is refused with the platforms that can.
import type { EnrichRunConfig } from '../lib/enrich-run-config';
import type { EnrichRunInput, InputBinding } from '../lib/enrich-run-input';
import {
  COMMENT_COLUMNS as C, POST_COLUMNS as P, SEARCH_COLUMNS, STEP_COLUMNS as S, foundColumn,
} from '../lib/social/names';
import { PLATFORM_SPECS, type ListSpec, type Platform, type StepTool } from '../lib/social/platforms';
import type { SocialInput } from '../lib/social/input';
import { addsRows, getTool } from './enrich-catalog';
import { buildEnrichmentConfig } from './enrich-run-build';
import type { RunFail } from './run-shared';

export interface BuiltRun { input: EnrichRunInput; config: EnrichRunConfig }
export interface PlatformRuns {
  platform: Platform; search: BuiltRun; transcript: BuiltRun | null; creator: BuiltRun | null;
  comments: BuiltRun | null;
}

const ALL = { mode: 'all' as const, status: 'any' as const, test: null, rowIndexes: null };
const bind = (inputs: Record<string, string>): Record<string, InputBinding> =>
  Object.fromEntries(Object.entries(inputs).map(([k, column]) => [k, { column }]));

function base(toolId: string, columnName: string, inputs: Record<string, InputBinding>, runIf: string | null):
  EnrichRunInput {
  return {
    toolId, preset: null, columnName, continueColumn: false, inputs, cleanDomains: false, providerOrder: [],
    skipProviders: [], stopAtFirst: false, email: null, outputs: [], rows: ALL, conditions: [], runIf,
    maxCostPerRowUsd: null, spendLimitUsd: null, concurrency: null, fresh: false, rowGeneration: null, list: null,
  };
}

// A list into another sheet (its id filled at create), the source row's `from` column copied into each row.
function listInput(spec: ListSpec, columnName: string, inputs: Record<string, InputBinding>, perSource: number,
  copy: Array<{ from: string; to: string; value?: string }>, runIf: string | null): EnrichRunInput {
  return {
    ...base(spec.toolId, columnName, inputs, runIf), fresh: true,
    list: {
      dest: { sheetId: '' }, provider: spec.provider, maxItems: perSource, fields: spec.fields, copy,
      dedupePath: spec.dedupe.path, ...(spec.dedupe.also ? { dedupeAlso: spec.dedupe.also } : {}), keep: true,
    },
  };
}

function stepInput(tool: StepTool, columnName: string, runIf: string): EnrichRunInput {
  return {
    ...base(tool.toolId, columnName, bind(tool.inputs), runIf),
    outputs: tool.outputs.map(o => ({ key: o.key, path: o.path, columnName: o.columnName,
      ...(o.fromAnswer ? { fromAnswer: true } : {}) })),
  };
}

async function built(input: EnrichRunInput, columns: string[], what: string): Promise<BuiltRun | RunFail> {
  const config = await buildEnrichmentConfig(input, columns, 1);
  if ('fail' in config) return { fail: config.fail, message: `${what}: ${config.message}` };
  return { input, config: config.ok };
}

// Each chosen platform's runs, or why one can't be set up. postColumns: each platform's Posts columns.
export async function buildSocialRuns(input: SocialInput, postColumns: Record<Platform, string[]>):
  Promise<{ ok: PlatformRuns[] } | RunFail> {
  const out: PlatformRuns[] = [];
  for (const platform of input.platforms) {
    const spec = PLATFORM_SPECS[platform];
    const tool = await getTool(spec.search.toolId);
    if (!('ok' in tool)) {
      return { fail: 'upstream', message: `treg's ${spec.label} search can't be read now: ${tool.message}` };
    }
    if (!(await addsRows(tool.ok))) {
      return { fail: 'bad_request', message: `treg's ${spec.label} search doesn't answer as rows Cubex can add now. `
        + 'Leave it out, or try again later.' };
    }
    const searchCols = [SEARCH_COLUMNS.words];
    const search = await built(listInput(spec.search, foundColumn(spec.label),
      { [spec.search.query]: { column: SEARCH_COLUMNS.words } }, input.perSearch,
      [{ from: SEARCH_COLUMNS.words, to: P.search }, { from: '', to: P.firstSeen, value: '' }],
      `{{${SEARCH_COLUMNS.words}}} is not empty`), searchCols, `The ${spec.label} search`);
    if ('fail' in search) return search;
    const cols = postColumns[platform];
    const has = (step: string) => input.steps.includes(step as SocialInput['steps'][number]);
    const postIsSet = `{{${P.post}}} is not empty`;
    let transcript: BuiltRun | null = null, creator: BuiltRun | null = null, comments: BuiltRun | null = null;
    if (has('transcript')) {
      const t = await built(stepInput(spec.transcript, S.transcript, postIsSet), cols, `${spec.label} transcripts`);
      if ('fail' in t) return t;
      transcript = t;
    }
    if (has('creator') && spec.creator) {
      const who = Object.values(spec.creator.inputs)[0];
      const c = await built(stepInput(spec.creator, S.creator, `{{${who}}} is not empty`), cols,
        `${spec.label} creators`);
      if ('fail' in c) return c;
      creator = c;
    }
    if (has('comments')) {
      const c = await built(listInput(spec.comments, S.commentsFound, bind(spec.comments.inputs),
        input.perSearch, [{ from: P.post, to: C.post }, { from: '', to: C.platform, value: spec.label }], postIsSet),
      cols, `${spec.label} comments`);
      if ('fail' in c) return c;
      comments = c;
    }
    out.push({ platform, search, transcript, creator, comments });
  }
  return { ok: out };
}
