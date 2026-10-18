// A waterfall column's setup as an agent reads it (waterfall_column action
// 'describe', GET /api/v1/sheets/:id/waterfall-columns/:column): in the same
// snake_case shape waterfall_column takes, step ids included, so an agent can
// change a step and send the setup back with add_to_column. Without the
// 'secrets' scope an HTTP step's keys, header values and body read "…"
// (lib/waterfall/agent-mask.ts), which the same step sent back keeps.
import { maskHttpStep } from '../lib/waterfall/agent-mask';
import type { WaterfallSetup } from './waterfall-column';

const MASK_NOTE = 'HTTP steps show keys in URLs, header values and bodies as "…" (they need the secrets scope). '
  + 'Send such a step back with its id and URL unchanged to keep them.';

export function agentSetup(s: WaterfallSetup, o: { secrets: boolean }): Record<string, unknown> {
  const i = s.input;
  return {
    column_name: i.columnName, result_type: i.resultType, ...(i.phone ? { phone: i.phone } : {}),
    inputs: Object.fromEntries(i.inputs.map(x => [x.key, x.source === null ? null
      : 'column' in x.source ? x.source.column : { value: x.source.value }])),
    steps: i.steps.map(st => {
      const c = st.choices;
      const base = {
        id: st.id, label: st.label, on: st.on, requires: st.requires, ...(st.check ? { check: st.check } : {}),
      };
      if (c.kind === 'enrichment') {
        return {
          ...base, kind: c.kind, tool_id: c.toolId, inputs: c.inputs, value_path: c.valuePath,
          provider_order: c.providerOrder, skip_providers: c.skipProviders, stop_at_first: c.stopAtFirst,
          max_cost_usd: c.maxCostUsd,
        };
      }
      if (c.kind === 'ai') return { ...base, kind: c.kind, prompt: c.prompt, model: c.model, web_search: c.webSearch };
      if (c.kind === 'http') {
        const shown = o.secrets ? { url: c.url, headers: c.headers, body: c.body } : maskHttpStep(c);
        return { ...base, kind: c.kind, method: c.method, ...shown, value_path: c.valuePath, retries: c.retries };
      }
      if (c.kind === 'formula') return { ...base, kind: c.kind, formula: c.formula };
      return { ...base, kind: c.kind };
    }),
    answered_by_column: s.columns.answeredBy, step_columns: s.columns.steps,
    hide_step_columns: i.hideStepColumns, run_if: i.runIf, fresh: i.fresh,
    active_run_id: s.activeRunId, auto_run: s.autoRun,
    ...(!o.secrets && i.steps.some(st => st.choices.kind === 'http') ? { masked: MASK_NOTE } : {}),
  };
}
