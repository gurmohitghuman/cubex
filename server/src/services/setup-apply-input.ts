// The body of a "use this setup" request, checked: the app sends camelCase,
// /api/v1 and MCP snake_case. MCP leaves estimate_only on unless it's false
// (a setup can start many paid runs); the app and REST say which they want.
import type { ApplyInput } from './setup-apply';
import type { RunFail } from './run-shared';

const isMap = (v: unknown): v is Record<string, string> => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.values(v).every(x => typeof x === 'string');

export function applyInputOf(b: Record<string, unknown>, from: 'app' | 'v1' | 'mcp'): ApplyInput | RunFail {
  const field = (camel: string, snake: string) => (from === 'app' ? b[camel] : b[snake]);
  const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
  for (const [camel, snake] of [['inputs', 'inputs'], ['names', 'names'], ['models', 'models']]) {
    const v = field(camel, snake);
    if (v !== undefined && v !== null && !isMap(v)) return bad(`${snake} must be an object of names.`);
  }
  const first = field('firstRows', 'first_rows');
  if (first !== undefined && first !== null && typeof first !== 'number') return bad('first_rows must be a number.');
  const estimate = field('estimateOnly', 'estimate_only');
  if (estimate !== undefined && typeof estimate !== 'boolean') return bad('estimate_only must be true or false.');
  return {
    inputs: (field('inputs', 'inputs') ?? undefined) as Record<string, string> | undefined,
    names: (field('names', 'names') ?? undefined) as Record<string, string> | undefined,
    models: (field('models', 'models') ?? undefined) as Record<string, string> | undefined,
    firstRows: (first ?? null) as number | null,
    estimateOnly: from === 'mcp' ? estimate !== false : estimate === true,
  };
}
