// The body of a column run request, checked (services/column-run.ts): the app
// sends camelCase, /api/v1 and MCP snake_case. mode is required, as on every
// rerun an agent starts (a wrong default once re-billed a whole sheet).
// row_ids or a where narrow the rows the mode picks from. MCP leaves
// estimate_only on unless it's false (a column run can start several paid
// runs); the app and REST say which they want.
import { MAX_COLUMN_RUN_COLUMNS, MAX_COLUMN_RUN_ROW_IDS } from '../lib/constants-setups';
import { CAMEL, ceilingArgsOf } from '../lib/cost-ceiling';
import type { WhereItem } from '../lib/row-filter/where';
import type { RunFail } from './run-shared';

export const COLUMN_RUN_MODES = ['empty', 'errored', 'out_of_date', 'empty_or_out_of_date', 'all'] as const;
export type ColumnRunMode = typeof COLUMN_RUN_MODES[number];

export interface ColumnRunInput {
  columns: string[];
  mode: ColumnRunMode;
  rowIds: string[] | null;
  where: WhereItem[] | null;
  estimateOnly: boolean;
  maxCostUsd: number | null;
  allowUnpriced: boolean;
  webhookId: string | null;
}

const KEYS = {
  app: ['columns', 'mode', 'rowIds', 'where', 'estimateOnly', 'maxCostUsd', 'allowUnpriced', 'webhookId'],
  v1: ['columns', 'mode', 'row_ids', 'where', 'estimate_only', 'max_cost_usd', 'allow_unpriced', 'webhook_id'],
};

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string' && x !== '');

export function columnRunInputOf(b: Record<string, unknown>, from: 'app' | 'v1' | 'mcp'): ColumnRunInput | RunFail {
  const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
  const keys = KEYS[from === 'app' ? 'app' : 'v1'];
  const stray = Object.keys(b).find(k => !keys.includes(k) && b[k] !== undefined);
  if (stray) return bad(`Unknown field ${stray}.`);
  const field = (camel: string, snake: string) => (from === 'app' ? b[camel] : b[snake]);

  const columns = b.columns;
  if (!strings(columns) || columns.length === 0 || columns.length > MAX_COLUMN_RUN_COLUMNS) {
    return bad(`columns must list 1 to ${MAX_COLUMN_RUN_COLUMNS} column names.`);
  }
  const mode = b.mode;
  if (!(COLUMN_RUN_MODES as readonly unknown[]).includes(mode)) {
    return bad(`mode is required: ${COLUMN_RUN_MODES.join(', ')}.`);
  }
  const rowIds = field('rowIds', 'row_ids') ?? null;
  if (rowIds !== null && (!strings(rowIds) || rowIds.length === 0 || rowIds.length > MAX_COLUMN_RUN_ROW_IDS)) {
    return bad(`row_ids must list 1 to ${MAX_COLUMN_RUN_ROW_IDS.toLocaleString('en-US')} row ids. `
      + 'For more rows, choose them with a where.');
  }
  const where = b.where ?? null;
  if (where !== null && !Array.isArray(where)) return bad('where must be a list of conditions.');
  if (rowIds && where?.length) return bad('Send row_ids or where, not both.');
  const estimate = field('estimateOnly', 'estimate_only');
  if (estimate !== undefined && typeof estimate !== 'boolean') return bad('estimate_only must be true or false.');
  const hook = field('webhookId', 'webhook_id') ?? null;
  if (hook !== null && typeof hook !== 'string') return bad('webhook_id must be a string.');
  const ceiling = ceilingArgsOf(field('maxCostUsd', 'max_cost_usd'), field('allowUnpriced', 'allow_unpriced'),
    from === 'app' ? CAMEL : undefined);
  if ('error' in ceiling) return bad(ceiling.error);
  return {
    columns: [...new Set(columns)], mode: mode as ColumnRunMode, rowIds: rowIds ? [...new Set(rowIds)] : null,
    where: where?.length ? where as WhereItem[] : null,
    estimateOnly: from === 'mcp' ? estimate !== false : estimate === true,
    webhookId: hook, ...ceiling,
  };
}
