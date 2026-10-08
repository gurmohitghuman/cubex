// What a column's enrichment was set up with, read back from its newest run's
// config (pure): the drawer's "Edit enrichment" starts from it, and the column
// menu's reruns ("Retry failed rows"…) run it again on other rows. Each choice
// comes from the stored config only; the start re-checks it against treg's
// live catalog (services/enrich-run-build.ts), so a retired tool or a dropped
// output is refused there, as for a new run.
import { CUBEX_PATHS, inputTemplates, type EnrichCondition, type EnrichRunConfig } from './enrich-run-config';
import type { EmailStrategy } from './enrich-email-status';
import type { EnrichRunInput, InputBinding, OutputInput } from './enrich-run-input';

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
}

const COLUMN_REF = /^\{\{(.+)\}\}$/;
// The drawer's own paths for Cubex's outputs (client enrich-modal/outputs.ts).
const CLIENT_PATHS: Record<string, string | null> = {
  email: '$.output.email', email_status: null, found_by: '$._treg.served_by', checked_by: null,
};

function recallOutput(m: { columnName: string; jsonPath: string }): OutputInput {
  const cubex = Object.entries(CUBEX_PATHS).find(([, path]) => path === m.jsonPath)?.[0];
  if (cubex) return { key: cubex, path: CLIENT_PATHS[cubex] ?? null, columnName: m.columnName };
  const key = m.jsonPath.replace(/^\$\.(output\.)?/, '').slice(0, 200) || m.jsonPath.slice(0, 200);
  return { key, path: m.jsonPath, columnName: m.columnName };
}

export function recallChoices(config: EnrichRunConfig, statusColumn: string): RecalledChoices {
  const e = config.enrichment;
  const inputs: Record<string, InputBinding> = {};
  for (const [name, template] of Object.entries(inputTemplates(config))) {
    const ref = COLUMN_REF.exec(template);
    inputs[name] = ref ? { column: ref[1] } : { value: template };
  }
  return {
    toolId: e.toolId, toolName: e.toolName, preset: e.preset, columnName: statusColumn, inputs,
    cleanDomains: e.cleanDomains, providerOrder: [...e.route.prefer], skipProviders: [...e.route.exclude],
    stopAtFirst: e.route.stopAtFirst,
    email: e.email ? { accept: e.email.strategy, guess: e.email.guess, pattern: e.email.pattern } : null,
    outputs: config.responseMapping.map(recallOutput),
    conditions: e.rows.where.map(c => ({ ...c })),
    maxCostPerRowUsd: e.maxCostPerRowUsd, fresh: e.fresh,
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
    maxCostPerRowUsd: c.maxCostPerRowUsd, spendLimitUsd, fresh: c.fresh, rowGeneration,
  };
}
