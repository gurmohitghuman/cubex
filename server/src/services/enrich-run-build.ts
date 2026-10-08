// Turns a run-start request into the run's stored config, checked against the
// tool as treg's catalog describes it right now (catalog drift: a retired tool
// or an output the tool no longer has is refused here, so cells never quietly
// turn empty). Prices and the default caps come from the same functions as the
// drawer's estimate, so the run spends what the estimate said it could.
import { ENRICH_FEATURED, ENRICH_VERIFY_TOOL_ID, TREG_BASE_URL } from '../lib/constants';
import { toolTitle } from '../lib/enrich-tool-label';
import { defaultEmailLoopCap, defaultMaxCostPerRow, noProviderCanRun, type ProviderPick } from '../lib/enrich-estimate';
import { missingInputs } from '../lib/enrich-request';
import { validateHttpJsonPath } from '../lib/jsonpath-extract';
import {
  CUBEX_PATHS, providerNamesOf, requestToolOf, routeFor, type EnrichRunConfig, type EnrichmentBlock,
} from '../lib/enrich-run-config';
import type { EnrichRunInput } from '../lib/enrich-run-input';
import type { HTTPRequestConfig, ResponseMapping } from '../lib/http-request-template';
import type { EnrichTool } from '../lib/enrich-tool';
import { getTool } from './enrich-catalog';
import type { RunFail } from './run-shared';

const EMAIL_KEYS = new Set(['email', 'email_status', 'found_by', 'checked_by']);
const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function outputMapping(input: EnrichRunInput, tool: EnrichTool): ResponseMapping[] | RunFail {
  const known = new Set(tool.outputs.map(o => o.path));
  const mapping: ResponseMapping[] = [];
  for (const o of input.outputs) {
    let jsonPath: string;
    if (input.preset === 'verified_email') {
      if (!EMAIL_KEYS.has(o.key)) return bad(`Verified work email can't add "${o.key}" as a column.`);
      jsonPath = CUBEX_PATHS[o.key as keyof typeof CUBEX_PATHS];
    } else if (o.key === 'found_by' && tool.kind === 'waterfall') {
      jsonPath = CUBEX_PATHS.found_by;
    } else {
      if (!o.path || !known.has(o.path)) return bad(`"${o.columnName}" reads a field this tool doesn't return anymore. Pick the outputs again.`);
      jsonPath = o.path;
    }
    const check = validateHttpJsonPath(jsonPath);
    if (!check.ok) return bad(`"${o.columnName}": ${check.reason}`);
    mapping.push({ columnName: o.columnName, jsonPath });
  }
  return mapping;
}

function inputTemplatesFor(input: EnrichRunInput, tool: EnrichTool, columns: string[]): { templates: Record<string, string> } | RunFail {
  const declared = new Set(tool.inputs.map(i => i.name));
  const have = new Set(columns);
  const templates: Record<string, string> = {};
  for (const [name, b] of Object.entries(input.inputs)) {
    if (!declared.has(name)) return bad(`This tool has no input "${name}" anymore. Pick the inputs again.`);
    if ('column' in b) {
      if (!have.has(b.column)) return bad(`The column "${b.column}" isn't in this sheet anymore.`);
      if (/[{}]/.test(b.column)) return bad(`Rename the column "${b.column}" first: names with { or } can't be inputs.`);
      templates[name] = `{{${b.column}}}`;
    } else templates[name] = b.value;
  }
  return { templates };
}

export async function buildEnrichmentConfig(
  input: EnrichRunInput, columns: string[], rowsUpperBound: number,
): Promise<{ ok: EnrichRunConfig } | RunFail> {
  const found = await getTool(input.toolId);
  if (!('ok' in found)) return bad(found.fail === 'not_found' || found.fail === 'hidden' ? `${found.message} Pick another tool.` : found.message);
  const tool = found.ok;
  if (tool.kind === 'waterfall' && tool.list) return bad('Adding results as rows in another sheet arrives in a later step.');
  let verify: EnrichTool | null = null;
  if (input.preset === 'verified_email') {
    if (tool.capability !== 'people.email.find' || tool.kind !== 'waterfall') return bad('Verified work email runs on the email finder only.');
    const v = await getTool(ENRICH_VERIFY_TOOL_ID);
    if (!('ok' in v)) return bad(`Can't load the email checker: ${v.message}`);
    verify = v.ok;
  }
  const filled = inputTemplatesFor(input, tool, columns);
  if ('fail' in filled) return filled;
  const { templates } = filled;
  const given = Object.keys(templates);
  const missing = missingInputs(requestToolOf(tool), new Set(given));
  if (missing) return bad(`Pick columns for ${missing}.`);
  const pick: ProviderPick = { skip: input.skipProviders, given, order: input.providerOrder, stopAtFirst: input.stopAtFirst };
  if (noProviderCanRun(tool, pick)) return bad('No provider can run with these inputs and switches. Map more inputs or switch providers on.');
  const mapping = outputMapping(input, tool);
  if ('fail' in mapping) return mapping;

  // A tool with no listed price runs on the team's own provider key: the
  // provider bills it, so there is no cap to send and no run limit to keep.
  const priceKnown = tool.kind === 'waterfall' || tool.price.usd !== null || tool.price.type === 'free' || tool.price.overflowUsd !== null;
  let cap: number | null = null;
  if (priceKnown) {
    cap = input.maxCostPerRowUsd ?? (verify
      ? defaultEmailLoopCap(defaultMaxCostPerRow(tool, pick), defaultMaxCostPerRow(verify, { given: ['email'] }))
      : defaultMaxCostPerRow(tool, pick));
  }
  const spendLimit = cap === null ? null : input.spendLimitUsd ?? round6(Math.max(rowsUpperBound, 1) * cap);
  // A micro of slack: a quoted limit is the estimate rounded to 6 decimals.
  if (cap !== null && spendLimit !== null && spendLimit + 1e-6 < cap) {
    return bad(`The run limit ($${spendLimit}) is below the max per row ($${cap}), so no row could run. Raise the run limit.`);
  }

  const enrichment: EnrichmentBlock = {
    v: 1, toolId: tool.id, kind: tool.kind, preset: input.preset,
    // The title the drawer shows ("Verified work email"), not treg's raw name.
    toolName: toolTitle(tool, ENRICH_FEATURED.find(j => j.id === tool.id && (j.preset ?? null) === input.preset)?.title),
    toolSnapshot: requestToolOf(tool), providerNames: providerNamesOf(tool, ...(verify ? [verify] : [])),
    route: routeFor(tool, input.providerOrder, input.skipProviders, input.stopAtFirst),
    cleanDomains: input.cleanDomains, fresh: input.fresh, maxCostPerRowUsd: cap, spendLimitUsd: spendLimit,
    rows: { mode: input.rows.mode, status: input.rows.status, test: input.rows.test, where: input.conditions },
    email: verify && input.email ? {
      strategy: input.email.accept, guess: input.email.guess, pattern: input.email.pattern,
      verifyTool: requestToolOf(verify), verifyExclude: routeFor(verify, [], [], false).exclude, verifyKind: verify.kind,
    } : null,
  };
  // Shown in run details only; calls are always built from the tool id and
  // TREG_BASE_URL, never from this URL. The input templates sit in body so a
  // column rename rewrites them (lib/http-columns.ts).
  const requestConfig: HTTPRequestConfig = {
    method: tool.method as HTTPRequestConfig['method'], url: `${TREG_BASE_URL}/call/${encodeURIComponent(tool.id)}`,
    headers: {}, body: JSON.stringify(templates),
  };
  return { ok: { requestConfig, responseMapping: mapping, previewSize: 5, enrichment } };
}
