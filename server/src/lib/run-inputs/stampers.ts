// The stamper a run's worker makes when it starts (lib/run-inputs/stamp.ts),
// from the run's own setup and the sheet's columns then: an AI run's prompt,
// an HTTP API, enrichment or waterfall run's request and inputs.
import { getSheetColumns } from '../sql-helpers';
import { aiRunInputColumns, requestRunInputColumns, type AiInputFields } from './columns';
import { runInputStamper, type RunInputStamper } from './stamp';
import type { HTTPAPIConfig } from '../http-request-template';

export function aiRunStamper(run: AiInputFields & { sheet_id: string; user_id: string }): RunInputStamper {
  const columns = getSheetColumns(run.sheet_id, run.user_id, false);
  return runInputStamper(run.sheet_id, run.user_id, run.column_name, aiRunInputColumns(run, columns));
}

// null: a run without a main column (a waterfall's dry run) writes no cells.
export function requestRunStamper(
  run: { sheet_id: string; user_id: string; master_column_name: string | null }, config: HTTPAPIConfig,
): RunInputStamper | null {
  if (!run.master_column_name) return null;
  const columns = getSheetColumns(run.sheet_id, run.user_id, false);
  return runInputStamper(run.sheet_id, run.user_id, run.master_column_name,
    requestRunInputColumns(config, run.master_column_name, columns));
}
