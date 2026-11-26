// The body of a setup call (services/setup-call.ts), checked, for /api/v1 and MCP (snake_case both): the items are
// checked by the call itself, against the setup's inputs. MCP leaves estimate_only on unless it's false, as
// apply_setup does (a call can start many paid runs); REST says which it wants (default false).
// max_cost_usd / allow_unpriced: the ceiling (lib/cost-ceiling.ts).
import type { CallInput } from './setup-call';
import type { RunFail } from './run-shared';
import { ceilingArgsOf } from '../lib/cost-ceiling';

const isMap = (v: unknown): v is Record<string, string> => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.values(v).every(x => typeof x === 'string');

export function callInputOf(b: Record<string, unknown>, from: 'v1' | 'mcp'): CallInput | RunFail {
  const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
  if (b.models !== undefined && b.models !== null && !isMap(b.models)) return bad('models must be an object of names.');
  if (b.estimate_only !== undefined && typeof b.estimate_only !== 'boolean') {
    return bad('estimate_only must be true or false.');
  }
  if (b.webhook_id !== undefined && b.webhook_id !== null && typeof b.webhook_id !== 'string') {
    return bad('webhook_id must be a string.');
  }
  const ceiling = ceilingArgsOf(b.max_cost_usd, b.allow_unpriced);
  if ('error' in ceiling) return bad(ceiling.error);
  return {
    models: (b.models ?? undefined) as Record<string, string> | undefined,
    estimateOnly: from === 'mcp' ? b.estimate_only !== false : b.estimate_only === true,
    webhookId: typeof b.webhook_id === 'string' ? b.webhook_id : null,
    ...ceiling,
  };
}
