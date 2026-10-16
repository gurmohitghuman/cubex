// What a setup holds (pure): a chain of steps, each one filled column as it
// was set up, with its column references written as they were. The steps
// come in an order where each one follows the steps whose columns it reads
// (graph.ts). Inputs are the columns the chain reads and no step makes; keys
// are the saved keys its requests name (names only: a value is never kept).
// Each kind keeps what its start service takes, so using a setup starts the
// same runs the column dialogs and agents start.
import type { OutputColumnSpec } from '../ai-multi-output';
import type { RecalledChoices } from '../enrich-run-recall';

// Auto-run as it was on the column: its rule and its daily cap (dollars for
// an enrichment, rows for an HTTP API column).
export interface AutoRunSpec { runIf: string | null; dailyCapUsd: number | null; dailyRowCap: number | null }

export interface AiStep {
  kind: 'ai';
  // The base name: "<name> (Output)" (and "<name> (Data)" with web search), or
  // for structured output "<name> (Status)" beside its output columns.
  name: string;
  prompt: string;
  systemPrompt: string | null;
  model: string | null;
  temperature: number;
  maxChars: number | null;
  concurrency: number | null;
  webSearch: boolean;
  webFetch: boolean;
  search: { engine: string; mode: string | null; maxPerRow: number | null } | null;
  outputColumns: OutputColumnSpec[] | null;
  runIf: string | null;
}

export interface HttpStep {
  kind: 'http';
  name: string; // the status column
  request: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; headers: Record<string, string>;
    body: string | null; timeout: number | null;
  };
  mappings: Array<{ jsonPath: string; columnName: string }>;
  batchSize: number | null;
  runIf: string | null;
  autoRun: AutoRunSpec | null;
}

// An enrichment's choices as its column menu recalls them (lib/enrich-run-recall.ts),
// without a list job (those add rows to another sheet: not in a setup).
export type EnrichStep = { kind: 'enrichment'; name: string; autoRun: AutoRunSpec | null }
  & Omit<RecalledChoices, 'columnName' | 'list'>;

export interface CleanStep {
  kind: 'clean'; name: string; source: string; cleaner: string; options: Record<string, unknown>; autoRun: boolean;
}

export interface FormulaStep {
  kind: 'formula'; name: string; formula: string; description: string | null; autoRun: boolean;
}

export type SetupStep = AiStep | HttpStep | EnrichStep | CleanStep | FormulaStep;
export type StepKind = SetupStep['kind'];
export const STEP_KINDS: readonly StepKind[] = ['ai', 'http', 'enrichment', 'clean', 'formula'];

export interface SetupSpec { v: 1; inputs: string[]; keys: string[]; steps: SetupStep[] }

const aiData = (s: AiStep): boolean => s.webSearch || (!!s.outputColumns?.length && s.webFetch);

// Every column a step makes, its main column first (the one its menu and its
// runs go by).
export function stepColumns(s: SetupStep): string[] {
  switch (s.kind) {
    case 'ai': {
      const data = aiData(s) ? [`${s.name} (Data)`] : [];
      return s.outputColumns?.length
        ? [`${s.name} (Status)`, ...s.outputColumns.map(o => o.columnName), ...data]
        : [`${s.name} (Output)`, ...data];
    }
    case 'http': return [s.name, ...s.mappings.map(m => m.columnName)];
    case 'enrichment': return [s.name, ...s.outputs.map(o => o.columnName)];
    default: return [s.name];
  }
}

export const mainColumn = (s: SetupStep): string => stepColumns(s)[0];

// A step in a few words, for lists: "AI · Score (Output)".
export const KIND_LABEL: Record<StepKind, string> = {
  ai: 'AI', http: 'HTTP API', enrichment: 'Enrichment', clean: 'Clean data', formula: 'Formula',
};
