import { RunFail } from './run-shared';
import { OutputColumnSpec } from '../lib/ai-multi-output';

// Params/outcome for startAiRun (services/ai-run-start.ts). Split out to keep
// that file focused on the flow; callers import the function, not these types.

export interface AiRunStartParams {
  sheetId: string;
  cleanColumnName: string;   // already sanitized (parseRunRequest)
  prompt: string;
  systemPrompt: string | undefined;
  model: string | undefined;
  useOpenRouterWebSearch: boolean;
  useWebFetch: boolean;
  safeTemperature: number;
  // undefined = caller didn't specify; resolved from the sheet default.
  safeConcurrency?: number;
  safeMaxChars: number | null;
  // v1/MCP only: run just these row_index values (resolved from stable row
  // ids by the caller). undefined = full sheet, the historical UI behavior.
  targetRowIndexes?: number[];
  // Structured multi-column output (MCP only). When present, ONE AI call per row
  // writes these typed columns + a status column; startAiRun delegates to
  // startAiMultiRun. undefined = single-column, unchanged behavior.
  outputColumns?: OutputColumnSpec[];
}

export type AiRunStartOutcome =
  | { ok: {
      runId: string; reusedRows: number; targetCount: number;
      // Single-column runs return these:
      outputColumn?: string; dataColumn?: string | null;
      // Structured (multi-column) runs return these instead:
      statusColumn?: string; outputColumns?: string[];
    } }
  | RunFail;
