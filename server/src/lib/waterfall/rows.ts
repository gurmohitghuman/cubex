// Whether a waterfall can do anything for a row (pure): some step that's on
// has its inputs, by its own alternatives and, for an enrichment step, by its
// tool's rule (lib/enrich-request.ts buildRequest, treg's derive included).
// Seeding takes only such rows (lib/enrich-seed.ts); a row with none gets no ⏳
// and reads as not run yet, so a later run or auto-run picks it up once filled.
import { buildRequest } from '../enrich-request';
import { goneColumnsOf } from '../template-token-match';
import { rowSteps, type EnrichmentChoices, type WaterfallRunConfig, type WaterfallStep } from './config';
import { inputMapOf, inputValues, requiresMet } from './inputs';

// An enrichment step's tool input map, read against the waterfall's inputs:
// {tool input: "{{key}}" | fixed value}.
export function toolTemplates(choices: EnrichmentChoices): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, src] of Object.entries(choices.inputs)) {
    out[name] = typeof src === 'string' ? `{{${src}}}` : src.value;
  }
  return out;
}

export function stepCanRun(step: WaterfallStep, inputs: Record<string, string>): boolean {
  if (!requiresMet(step.requires, inputs)) return false;
  if (step.choices.kind !== 'enrichment' || step.built.kind !== 'enrichment') return true;
  const built = buildRequest(step.built.toolSnapshot, toolTemplates(step.choices), inputs,
    { cleanDomains: step.built.cleanDomains, columns: Object.keys(inputs) });
  return built.ok || !('missing' in built);
}

export function rowInputs(config: WaterfallRunConfig, row: Record<string, string>, columns: readonly string[]) {
  const keys = config.waterfall.inputs.map(i => i.key);
  return inputValues(inputMapOf(config), row, goneColumnsOf(config.requestConfig), keys, columns);
}

export function waterfallRowCanRun(
  config: WaterfallRunConfig, row: Record<string, string>, columns: readonly string[],
): boolean {
  const inputs = rowInputs(config, row, columns);
  return rowSteps(config).some(s => stepCanRun(s, inputs));
}
