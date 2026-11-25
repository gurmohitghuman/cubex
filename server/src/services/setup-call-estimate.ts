// A setup call's estimate (estimate_only, its default): a pure read, as every estimate is. It makes no working table,
// row, column or run and writes nothing. The setup is fitted to its inputs as it is to a sheet (setup-apply.ts
// fitSetup: the columns are the setup's inputs, none filled yet) and priced by the setup's own estimate
// (setup-estimate.ts) on the items, held in memory as a working table's rows would hold them: each step's price a
// row times the items that reach it (an AI step's "Only run if" rule is judged on each item), the same low and high
// ends, unpriced steps and max_cost_usd check. A start then makes the working table (setup-call.ts).
import { ceilingView } from '../lib/cost-ceiling';
import type { SetupDetail } from './setup-library';
import { fitSetup, type ApplyFail, type ApplyInput, type PricedEstimate } from './setup-apply';
import { estimateSetup } from './setup-estimate';
import { setupCeilingFigures } from './setup-ceiling';

export async function estimateSetupCall(
  userId: string, setup: SetupDetail, items: Array<Record<string, string>>, input: ApplyInput,
  caller: { hasSecretsScope: boolean },
): Promise<{ ok: { estimate: PricedEstimate; makes: string[]; items: number } } | ApplyFail> {
  const columns = [...setup.spec.inputs];
  const fitted = await fitSetup(userId, setup, { sheetId: null, columns, existing: [] }, input, caller);
  if ('fail' in fitted) return fitted;
  const { spec, layers, modes, makes } = fitted.ok;
  const est = await estimateSetup(userId, { sheetId: null, items: { columns, rows: items } },
    { spec, layers, modes }, columns, items.length, null, []);
  const ceiling = { maxCostUsd: input.maxCostUsd ?? null, allowUnpriced: !!input.allowUnpriced };
  const estimate = { ...est, ...ceilingView(setupCeilingFigures(est), ceiling) };
  return { ok: { estimate, makes, items: items.length } };
}
