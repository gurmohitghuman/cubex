// A step's check, built for the run (services/waterfall-build.ts): treg's
// email verify (result type email only), frozen from the catalog as it is now
// with its cap from the same function an enrichment's start uses; or a
// formula over {{value}} and the waterfall's inputs, compiled once (its text
// runs in the formula worker, lib/formula/). A formula step compiles here too.
import { ENRICH_VERIFY_TOOL_ID } from '../lib/constants';
import { defaultMaxCostPerRow } from '../lib/enrich-estimate';
import { providerNamesOf, requestToolOf, routeFor } from '../lib/enrich-run-config';
import { compileFormula, FormulaError, type CompiledFormula } from '../lib/formula/refs';
import type { CheckChoices, StepCheck } from '../lib/waterfall/config';
import type { ResultType } from '../lib/waterfall/result-type';
import { getTool } from './enrich-catalog';
import type { RunFail } from './run-shared';

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

// A formula naming the waterfall's inputs (and, for a check, {{value}}).
export function compileStepFormula(where: string, text: string, names: string[]): { ok: CompiledFormula } | RunFail {
  try {
    return { ok: compileFormula(text, names) };
  } catch (error) {
    if (error instanceof FormulaError) return bad(`${where}: ${error.message.replace(/column/g, 'input')}`);
    throw error;
  }
}

export async function buildCheck(
  where: string, check: CheckChoices | null, resultType: ResultType, inputKeys: string[],
): Promise<{ ok: StepCheck | null } | RunFail> {
  if (!check) return { ok: null };
  if (check.kind === 'formula') {
    if (inputKeys.includes('value')) {
      return bad(`${where}: an input named "value" can't be used with a formula check (it names the answer).`);
    }
    const compiled = compileStepFormula(`${where}, its check`, check.formula, ['value', ...inputKeys]);
    if ('fail' in compiled) return compiled;
    return { ok: { choices: check, built: { kind: 'formula', compiled: compiled.ok } } };
  }
  if (resultType !== 'email') return bad(`${where}: an email check needs the result type Work email.`);
  const found = await getTool(ENRICH_VERIFY_TOOL_ID);
  if (!('ok' in found)) {
    const gone = found.fail === 'not_found' || found.fail === 'hidden';
    return gone ? bad(`${where}: treg's email verify isn't available.`) : { fail: 'upstream', message: found.message };
  }
  const tool = found.ok;
  const priceKnown = tool.kind === 'waterfall' || tool.price.usd !== null || tool.price.type === 'free';
  return {
    ok: {
      choices: check,
      built: {
        kind: 'verify', tool: requestToolOf(tool), toolKind: tool.kind, exclude: routeFor(tool, [], [], false).exclude,
        providerNames: providerNamesOf(tool), capUsd: priceKnown ? defaultMaxCostPerRow(tool) : null,
      },
    },
  };
}
