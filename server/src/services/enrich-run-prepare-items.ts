// An enrichment start's checks on a call's items, in memory (an enrichment call's estimate: enrich-call-estimate.ts),
// a pure read. The items are the rows of the working table a start makes, one column per input they use and no run
// on it yet, so what a start checks against a sheet's runs (a column a run already made, an input another run holds,
// a list job's destination) has nothing to find. The rest is the start's own (enrich-run-prepare.ts): the status and
// output names, the rows it takes (every item; rows missing an input count too) and the config built against treg's
// catalog (the tool and its inputs, provider routing, the per-row cap and the run limit). A call takes every item,
// so a sheet's choices (rows, conditions, a rule, a list job, a column carried on or saved) are refused here.
import { validateRunColumnsOn } from '../lib/http-run-validate';
import type { EnrichRunInput } from '../lib/enrich-run-input';
import { buildEnrichmentConfig } from './enrich-run-build';
import type { PreparedStart } from './enrich-run-prepare';
import type { EstimateItems } from './run-estimate-rows';
import type { RunFail } from './run-shared';

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

export async function prepareEnrichmentOnItems(
  input: EnrichRunInput, items: EstimateItems,
): Promise<{ ok: PreparedStart } | RunFail> {
  if (input.saveOnly || input.list || input.continueColumn || input.rows.mode !== 'all'
    || input.conditions.length > 0 || input.runIf) {
    return bad('A call runs its tool on every item: choosing rows, a list job or a column to carry on needs a sheet.');
  }
  const count = items.rows.length;
  if (count === 0) return bad('There are no rows to run on.');
  const mapping = input.outputs.map(o => ({ columnName: o.columnName, jsonPath: '$.x' }));
  const v = validateRunColumnsOn(() => items.columns, mapping, input.columnName, true);
  if (!v.ok) return bad(v.error!);
  const outputNames = v.sanitizedMappingColumns!;
  const upperBound = Math.min(input.rows.test ?? count, count);
  const named = { ...input, outputs: input.outputs.map((o, i) => ({ ...o, columnName: outputNames[i] })) };
  const built = await buildEnrichmentConfig(named, items.columns, upperBound);
  if ('fail' in built) return built;
  return {
    ok: {
      statusColumn: v.sanitizedMaster!, outputNames, config: built.ok, listPlan: null, columns: items.columns,
      span: { count, lastRow: count - 1 }, upperBound, rule: null, stale: null, ignoredProviders: built.ignored ?? [],
    },
  };
}
