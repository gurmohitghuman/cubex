// What the run tools answer (tools-run-start.ts, tools-run-conditions.ts, tools-run-status.ts,
// tools-run-manage.ts, tools-run-undo.ts, tools-run-results.ts, tools-run-webhooks.ts).
import { z } from 'zod';
import { obj, open } from '../output-schema';
import { bool, info, nul, num, opt, str, strs } from './shared';
import { runSummary } from './read';

const range = obj({ low: num, high: num });
const replayed = opt(bool).describe('true: an idempotency_key retry answered with the first run');
const runIf = { run_if: opt(str), rows_skipped_by_rule: opt(num), run_if_note: opt(str) };

// Started: run_id. With estimate_only: the estimate, and nothing started.
export const runAiColumn = obj({
  run_id: opt(str), output_column: opt(str), status_column: opt(str), output_columns: opt(strs),
  data_column: opt(nul(str)), reused_rows: opt(num), target_rows: opt(num), rows_to_process: opt(num),
  model: opt(nul(str)), pricing_available: opt(bool), estimated_cost_usd: opt(nul(range)),
  per_row_usd: opt(nul(range)), row_most_usd: opt(nul(num)), web_fees_usd: opt(nul(range)),
  web_search: opt(nul(info('The web search a row may make, and its price'))), basis: opt(str),
  in_flight: opt(info('What a row reserves while it runs')),
  assumptions: opt(info('The tokens the estimate assumes per row')), own_provider_key: opt(bool),
  max_cost_usd: opt(num), over_ceiling: opt(bool), ceiling_problem: opt(nul(str)), spend_limit_usd: opt(num),
  ...runIf, webhook_id: opt(str), note: opt(str), replayed,
});

export const runHttpEnrichment = obj({
  run_id: opt(str), master_column: opt(str), mapped_columns: opt(strs), target_rows: opt(num),
  rows_to_process: opt(num), saved_keys: opt(strs), notes: opt(strs), ai_cost_usd: opt(z.null()),
  ...runIf, webhook_id: opt(str), note: opt(str), replayed,
});

export const checkRunCondition = obj({
  rule: str, columns: strs, rows_checked: num, rows_passing: num, rows_skipped: num,
  sample: z.array(info('A row checked: its id, the cells read and whether it passes')),
});
export const writeRunCondition = obj({
  model: str, model_source: str, cost_usd: num,
  check: info('check_run_condition\'s answer for the rule written, with the rule'),
});

// The run (list_runs' fields), with what its type adds: enrichment, waterfall, providers, waiting.
export const getRunStatus = runSummary;

// pause, resume or cancel: the run. rerun: run_id and the rows. cancel_all: what stopped.
export const controlRun = open({
  run_id: opt(str), run_type: opt(str), target_rows: opt(num), rows_in_scope: opt(num), webhook_id: opt(str),
  destination_auto_run: opt(info('Auto-run on the sheet a list enrichment adds rows to')),
  stopped_runs: opt(z.array(info('A run stopped'))), stopped_setup_runs: opt(z.array(info('A setup run stopped'))),
  auto_run_paused: opt(strs), auto_run_on: opt(strs), still_filling: opt(strs), message: opt(str),
  id: opt(str), status: opt(str),
});

export const undoRun = obj({
  run_id: str, run_type: str, sheet_id: str, column: str, state: str, rows: num, restored: num, skipped: num,
  gone: num, started_at: str, undone_at: nul(str), kept_until: nul(str), can_undo: bool, reason: nul(str),
  message: str,
});

export const getRunResults = obj({
  run_type: str, run_id: str, status_filter: str,
  results: z.array(info('A row\'s result: row id, status, value or error; a waterfall row\'s answered_by and trace')),
  error_summary: opt(z.array(info('A kind of error and how many rows have it'))),
  next_cursor: nul(num).describe('Pass as cursor for the next page; null at the end'),
});

const delivery = obj({
  id: str, event: str, run_id: nul(str), kind: nul(str), run_status: nul(str), state: str, tries: num,
  response_code: nul(num), error: nul(str), created_at: str, finished_at: nul(str),
});
const lastDelivery = obj({ state: str, response_code: nul(num), error: nul(str), created_at: str });
const webhook = obj({
  id: str, url: str, every_run: bool, created_at: str, updated_at: str, last_delivery: nul(lastDelivery),
});
// No webhook_id: webhooks. With one: that webhook and its deliveries.
export const listRunWebhooks = obj({
  webhooks: opt(z.array(webhook)), ...webhook.partial().shape, deliveries: opt(z.array(delivery)),
});
export const manageRunWebhook = obj({
  webhook: opt(webhook), secret: opt(str).describe('create: shown once, to check signatures'),
  delivery: opt(delivery), deleted: opt(bool),
});
