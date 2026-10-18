// An enrichment step of a waterfall, checked against treg's catalog as it is
// now and frozen for the run (services/waterfall-build.ts): the tool must find
// one value (a job that adds rows can't be a step), its inputs map to the
// waterfall's inputs (by name unless the step says otherwise), at least one
// provider must be able to run with them, and the answer field the step reads
// must be one the tool returns. Its cap and route come from the same functions
// an enrichment column's start uses (lib/enrich-estimate.ts), so a step spends
// what its estimate said.
import { defaultMaxCostPerRow, noProviderCanRun, type ProviderPick } from '../lib/enrich-estimate';
import { missingInputs } from '../lib/enrich-request';
import { validateHttpJsonPath } from '../lib/jsonpath-extract';
import { providerNamesOf, requestToolOf, routeFor } from '../lib/enrich-run-config';
import { toolTitle } from '../lib/enrich-tool-label';
import type { EnrichTool } from '../lib/enrich-tool';
import { defaultValuePath, RESULT_INFO, type ResultType } from '../lib/waterfall/result-type';
import type { BuiltEnrichment, EnrichmentChoices } from '../lib/waterfall/config';
import { getTool } from './enrich-catalog';
import type { RunFail } from './run-shared';

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

export interface EnrichStepBuild {
  choices: EnrichmentChoices; built: BuiltEnrichment; tool: EnrichTool; pick: ProviderPick;
}

// The tool's inputs mapped to the waterfall's: as the step says, else by the
// same name, an input key the waterfall doesn't have refused.
function mapInputs(
  where: string, tool: EnrichTool, given: EnrichmentChoices['inputs'], keys: Set<string>,
): { ok: Record<string, string | { value: string }> } | RunFail {
  const declared = new Set(tool.inputs.map(i => i.name));
  const out: Record<string, string | { value: string }> = {};
  for (const [name, src] of Object.entries(given)) {
    if (!declared.has(name)) return bad(`${where}: the tool has no input "${name}".`);
    if (typeof src === 'string' && !keys.has(src)) {
      return bad(`${where}: "${src}" isn't one of the waterfall's inputs.`);
    }
    out[name] = src;
  }
  if (Object.keys(given).length === 0) {
    for (const i of tool.inputs) if (keys.has(i.name)) out[i.name] = i.name;
  }
  return { ok: out };
}

export async function buildEnrichmentStep(
  where: string, choices: EnrichmentChoices, resultType: ResultType, inputKeys: string[], mappedKeys: Set<string>,
): Promise<{ ok: EnrichStepBuild } | RunFail> {
  const found = await getTool(choices.toolId);
  if (!('ok' in found)) {
    const gone = found.fail === 'not_found' || found.fail === 'hidden';
    const message = `${where}: ${found.message}${gone ? ' Pick another tool.' : ''}`;
    // treg's catalog out of reach is a moment's problem, not the step's.
    return gone ? bad(message) : { fail: 'upstream', message };
  }
  const tool = found.ok;
  if (tool.list) return bad(`${where}: ${tool.name} adds rows to a sheet; a step needs a tool that finds one value.`);
  const mapped = mapInputs(where, tool, choices.inputs, new Set(inputKeys));
  if ('fail' in mapped) return mapped;
  const inputs = mapped.ok;
  // The tool inputs a row can fill: a fixed value, or an input mapped to a column.
  const given = Object.entries(inputs).filter(([, src]) => typeof src !== 'string' || mappedKeys.has(src))
    .map(([name]) => name);
  const missing = missingInputs(requestToolOf(tool), new Set(given));
  if (missing) return bad(`${where}: map a column to an input the tool needs (${missing}).`);
  const pick: ProviderPick = {
    skip: choices.skipProviders, given, order: choices.providerOrder, stopAtFirst: choices.stopAtFirst,
  };
  if (noProviderCanRun(tool, pick)) {
    return bad(`${where}: no provider can run with these inputs and switches. Map more inputs or switch providers on.`);
  }
  const valuePath = choices.valuePath ?? defaultValuePath(resultType, tool.outputs);
  if (!valuePath) {
    return bad(`${where}: pick the answer field that holds the ${RESULT_INFO[resultType].label.toLowerCase()} `
      + '(valuePath).');
  }
  const check = validateHttpJsonPath(valuePath);
  if (!check.ok) return bad(`${where}: valuePath ${check.reason}`);
  // A tool with no listed price runs on the team's own provider key: the provider bills it, no cap.
  const priceKnown = tool.kind === 'waterfall' || tool.price.usd !== null || tool.price.type === 'free'
    || tool.price.overflowUsd !== null;
  const capUsd = priceKnown ? choices.maxCostUsd ?? defaultMaxCostPerRow(tool, pick) : null;
  return {
    ok: {
      tool, pick,
      choices: { ...choices, inputs },
      built: {
        kind: 'enrichment', toolName: toolTitle(tool), toolKind: tool.kind, toolSnapshot: requestToolOf(tool),
        route: routeFor(tool, choices.providerOrder, choices.skipProviders, choices.stopAtFirst),
        providerNames: providerNamesOf(tool), capUsd, valuePath, cleanDomains: true,
      },
    },
  };
}
