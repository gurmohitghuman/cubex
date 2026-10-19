// The input cells of a run column (pure): what its run reads, in the order its
// setup names them, without the columns it writes (a prompt reading its own
// output would make every row it fills out of date at once). An AI run reads
// its prompt's /tokens (the system prompt goes verbatim); an HTTP API run its
// request's {{tokens}} that name columns; an enrichment or a waterfall its
// inputs. A token whose column is gone keeps its place as null (read as
// empty), so a deleted input makes out of date only the rows whose cell in it
// held something, as the run would now send it empty; a saved key's token is
// no input at all.
import { extractColumnReferences, matchPromptColumn } from '../prompt';
import { extractTemplateTokenNames, type HTTPAPIConfig } from '../http-request-template';
import { goneColumnFor, goneColumnsOf, templateTokenIs } from '../template-token-match';
import { inputTemplates, isEnrichmentConfig } from '../enrich-run-config';
import { isWaterfallConfig } from '../waterfall/config';
import { resolveColumn } from '../waterfall/inputs';
import { aiRunDataColumn, type AiRunDataColumnFields } from '../ai-data-column';

// A column a run reads, or null for an input whose column isn't there.
export type RunInputList = Array<string | null>;

// Distinct inputs in order; a run's own columns are not inputs. A column read
// through two token forms ({{Company Name}} and /company_name, as a rename
// writes them) is one input; only a token naming no column is told apart by
// its own text (token), so two gone columns stay two inputs.
class Inputs {
  private seenColumns = new Set<string>();
  private seenTokens = new Set<string>();
  readonly list: RunInputList = [];
  constructor(private readonly own: readonly string[]) {}
  add(column: string | null, token: string): void {
    if (column !== null) {
      if (this.own.includes(column) || this.seenColumns.has(column)) return;
      this.seenColumns.add(column);
    } else {
      if (this.seenTokens.has(token)) return;
      this.seenTokens.add(token);
    }
    this.list.push(column);
  }
}

export interface AiInputFields extends AiRunDataColumnFields {
  prompt: string | null;
  output_columns: string | null;
}

// An AI run's columns: its main column, its typed outputs and its "(Data)" column.
function aiOwnColumns(run: AiInputFields): string[] {
  const own = [run.column_name];
  if (run.output_columns) {
    try {
      for (const s of JSON.parse(run.output_columns) as Array<{ columnName?: unknown }>) {
        if (typeof s?.columnName === 'string') own.push(s.columnName);
      }
    } catch { /* malformed spec: the main column stays */ }
  }
  const data = aiRunDataColumn(run);
  if (data) own.push(data);
  return own;
}

export function aiRunInputColumns(run: AiInputFields, columns: readonly string[]): RunInputList {
  const out = new Inputs(aiOwnColumns(run));
  for (const ref of extractColumnReferences(run.prompt ?? '')) {
    out.add(matchPromptColumn(ref, columns) ?? null, `/${ref.toLowerCase()}`);
  }
  return out.list;
}

// The parts of an HTTP request that hold template tokens, in a fixed order.
function requestParts(config: HTTPAPIConfig): string[] {
  const rc = config.requestConfig;
  const parts: unknown[] = [rc?.url, rc?.body];
  if (rc?.headers && typeof rc.headers === 'object') {
    for (const [k, v] of Object.entries(rc.headers)) parts.push(k, v);
  }
  return parts.filter((p): p is string => typeof p === 'string');
}

const COLUMN_REF = /^\{\{(.+)\}\}$/;

// master: the run's status (or result) column; the response mapping names the rest.
export function requestRunInputColumns(config: HTTPAPIConfig, master: string, columns: string[]): RunInputList {
  const out = new Inputs([master, ...(config.responseMapping ?? []).map(m => m.columnName)]);
  const gone = goneColumnsOf(config.requestConfig);
  if (isWaterfallConfig(config) || isEnrichmentConfig(config)) {
    // Inputs mapped to a column ({{Website}}); fixed values aren't cells.
    for (const t of Object.values(inputTemplates(config))) {
      const ref = COLUMN_REF.exec(t);
      if (!ref) continue;
      const name = ref[1];
      // Each resolves the name as its run does: an enrichment's fillTemplate any case or the normalized
      // name (a rename to a name holding "}" writes that form), a waterfall the same unless the column is gone.
      const col = !isEnrichmentConfig(config) && gone.includes(name) ? null : resolveColumn(name, columns);
      out.add(col, `{{${name}}}`);
    }
    return out.list;
  }
  for (const part of requestParts(config)) {
    for (const name of extractTemplateTokenNames(part)) {
      const col = columns.find(c => templateTokenIs(name, c));
      if (col) out.add(col, `{{${name.toLowerCase()}}}`);
      else if (goneColumnFor(name, gone)) out.add(null, `{{${name.toLowerCase()}}}`);
    }
  }
  return out.list;
}
