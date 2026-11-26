// An enrichment call's estimate (estimate_only, its default, and the price a start is checked against first): a pure
// read, as every estimate is. It makes no working table, row, column or run and writes nothing. The items are held in
// memory as the working table's rows would hold them (one column per input they use, named by callColumns) and priced
// by run_enrichment's own estimate (enrich-token-estimate.ts): the start's checks on them (enrich-run-prepare-items.ts:
// the tool and its inputs, provider routing), the per-row price range, the items that reuse a found answer for the
// same inputs at $0, today's limit and the treg balance. A start then makes the working table (enrich-call.ts).
import { sanitizeAndValidateColumnName } from '../lib/column-names';
import type { AgentRunArgs } from '../lib/enrich-agent-input';
import type { EnrichTool } from '../lib/enrich-tool';
import { agentEnrichEstimate } from './enrich-token-estimate';
import { agentEnrichInput, agentWords } from './enrich-token-run';
import { webhookIdProblem } from './run-hooks-attach';
import type { EstimateItems } from './run-estimate-rows';
import { bad, type Fail, type TokenCaller } from './run-start-token';

export type EnrichCallEstimate = Extract<Awaited<ReturnType<typeof agentEnrichEstimate>>, { ok: unknown }>['ok'];

export async function estimateEnrichCall(
  c: TokenCaller, tool: EnrichTool, args: AgentRunArgs & { webhook_id?: string }, items: EstimateItems,
): Promise<{ ok: EnrichCallEstimate } | Fail> {
  // The columns a start adds to its working table, checked as it adds them (column-add.ts).
  for (const name of items.columns) {
    const v = sanitizeAndValidateColumnName(name);
    if ('error' in v) return bad(v.error);
  }
  const input = agentEnrichInput(args, tool, null, null);
  if ('fail' in input) return input;
  const hook = webhookIdProblem(c.userId, args.webhook_id);
  if (hook) return bad(hook);
  const est = await agentEnrichEstimate(c.userId, { sheetId: null, items }, input.ok);
  return 'fail' in est ? agentWords(est) : est;
}
