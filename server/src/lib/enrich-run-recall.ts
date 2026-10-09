// What a column's enrichment was set up with, read back from its newest run's
// config (pure): the drawer's "Edit enrichment" starts from it, and the column
// menu's reruns ("Retry failed rows"…) run it again on other rows. Each choice
// comes from the stored config only; the start re-checks it against treg's
// live catalog (services/enrich-run-build.ts), so a retired tool or a dropped
// output is refused there, as for a new run.
import { CUBEX_PATHS, inputTemplates, type EnrichCondition, type EnrichRunConfig } from './enrich-run-config';
import type { EmailStrategy } from './enrich-email-status';
import type { EnrichRunInput, InputBinding, OutputInput } from './enrich-run-input';
import type { ListInput } from './enrich-list-input';
import type { EstimateList } from './enrich-estimate-input';

export interface RecalledChoices {
  toolId: string;
  toolName: string;
  preset: 'verified_email' | null;
  columnName: string;
  inputs: Record<string, InputBinding>;
  cleanDomains: boolean;
  providerOrder: string[];
  // Providers the run left out: switched off, or unable to run in a sheet.
  skipProviders: string[];
  stopAtFirst: boolean;
  email: { accept: EmailStrategy; guess: boolean; pattern: string } | null;
  outputs: OutputInput[];
  conditions: EnrichCondition[];
  maxCostPerRowUsd: number | null;
  fresh: boolean;
  // A list job: where its results go and the fields it keeps.
  list: ListInput | null;
}

const COLUMN_REF = /^\{\{(.+)\}\}$/;
// The drawer's own paths for Cubex's outputs (client enrich-modal/outputs.ts).
const CLIENT_PATHS: Record<string, string | null> = {
  email: '$.output.email', email_status: null, found_by: '$._treg.served_by', checked_by: null,
};

function recallOutput(m: { columnName: string; jsonPath: string }, fromAnswer: Set<string>): OutputInput {
  if (fromAnswer.has(m.jsonPath)) {
    return { key: m.jsonPath.slice(0, 200), path: m.jsonPath, columnName: m.columnName, fromAnswer: true };
  }
  const cubex = Object.entries(CUBEX_PATHS).find(([, path]) => path === m.jsonPath)?.[0];
  if (cubex) return { key: cubex, path: CLIENT_PATHS[cubex] ?? null, columnName: m.columnName };
  const key = m.jsonPath.replace(/^\$\.(output\.)?/, '').slice(0, 200) || m.jsonPath.slice(0, 200);
  return { key, path: m.jsonPath, columnName: m.columnName };
}

function recallList(config: EnrichRunConfig): ListInput | null {
  const l = config.enrichment.list;
  if (!l) return null;
  return {
    dest: { sheetId: l.destSheetId }, provider: l.provider, maxItems: l.maxItems,
    fields: l.fields?.length ? l.fields.map(f => ({ ...f })) : null,
    copy: l.copy.map(c => ({ from: c.from, to: c.to })), dedupePath: l.dedupe?.path ?? null,
  };
}

export function recallChoices(config: EnrichRunConfig, statusColumn: string): RecalledChoices {
  const e = config.enrichment;
  const inputs: Record<string, InputBinding> = {};
  for (const [name, template] of Object.entries(inputTemplates(config))) {
    // A list job's page size comes from its results per row.
    if (e.list && name === 'limit') continue;
    const ref = COLUMN_REF.exec(template);
    inputs[name] = ref ? { column: ref[1] } : { value: template };
  }
  return {
    toolId: e.toolId, toolName: e.toolName, preset: e.preset, columnName: statusColumn, inputs,
    cleanDomains: e.cleanDomains, providerOrder: [...e.route.prefer], skipProviders: [...e.route.exclude],
    stopAtFirst: e.route.stopAtFirst,
    email: e.email ? { accept: e.email.strategy, guess: e.email.guess, pattern: e.email.pattern } : null,
    outputs: config.responseMapping.map(m => recallOutput(m, new Set(e.answerFields ?? []))),
    conditions: e.rows.where.map(c => ({ ...c })),
    maxCostPerRowUsd: e.maxCostPerRowUsd, fresh: e.fresh, list: recallList(config),
  };
}

// The same enrichment on the column it made, on other rows. The run limit is
// the one the confirm quoted, else sized to the rows this run takes.
export function rerunInput(
  c: RecalledChoices, rows: EnrichRunInput['rows'],
  spendLimitUsd: number | null = null, rowGeneration: number | null = null,
): EnrichRunInput {
  return {
    toolId: c.toolId, preset: c.preset, columnName: c.columnName, continueColumn: true, inputs: c.inputs,
    cleanDomains: c.cleanDomains, providerOrder: c.providerOrder, skipProviders: c.skipProviders,
    stopAtFirst: c.stopAtFirst, email: c.email, outputs: c.outputs, rows, conditions: c.conditions,
    maxCostPerRowUsd: c.maxCostPerRowUsd, spendLimitUsd, fresh: c.fresh, rowGeneration, list: c.list,
  };
}

// The estimate's list part for a column's own setup (reruns, auto-run's notices).
export function estimateListOf(c: RecalledChoices): EstimateList | null {
  if (!c.list) return null;
  return {
    provider: c.list.provider, maxItems: c.list.maxItems,
    destSheetId: 'sheetId' in c.list.dest ? c.list.dest.sheetId : null,
  };
}
