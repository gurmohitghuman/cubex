// Runs that would wait for each other (services/run-input-gate.ts). A running row waits while a column it reads
// is held by another run, so two runs that each read a column the other fills, or a longer ring of them, could
// never finish. The ring is looked for among the runs going on the sheet (pending, running or paused: a paused
// one can't resume while a column it reads is held, lib/run-resume-inputs.ts), each by what it reads
// (lib/run-inputs/columns.ts) and what it holds (lib/run-locked-columns.ts). A run that ended and is still
// putting its ⏳ cells back waits for nothing, so no ring goes through it. Runs only read their own sheet.
import { db } from './db';
import { getSheetColumns } from './sql-helpers';
import { addAiRunColumns, addHttpRunColumns, type AiRunWrites, type HttpRunWrites } from './run-locked-columns';
import { aiRunInputColumns, requestRunInputColumns, type AiInputFields } from './run-inputs/columns';
import type { HTTPAPIConfig } from './http-request-template';

export type RunKind = 'ai' | 'http';
interface Node { key: string; reads: string[]; holds: Set<string> }
export const runKey = (kind: RunKind, id: string): string => `${kind}:${id}`;

const named = (list: Array<string | null>): string[] => list.filter((c): c is string => c !== null);

function goingRuns(sheetId: string, userId: string): Node[] {
  const columns = getSheetColumns(sheetId, userId, false);
  const nodes: Node[] = [];
  const ai = db.prepare(`SELECT id, column_name, prompt, output_columns, data_column, use_openrouter_web_search
    FROM ai_runs WHERE sheet_id = ? AND user_id = ? AND status IN ('pending','running','paused')`)
    .all(sheetId, userId) as Array<AiInputFields & AiRunWrites & { id: string }>;
  for (const r of ai) {
    const holds = new Set<string>();
    addAiRunColumns(r, holds);
    nodes.push({ key: runKey('ai', r.id), reads: named(aiRunInputColumns(r, columns)), holds });
  }
  const http = db.prepare(`SELECT id, config, master_column_name FROM http_runs
    WHERE sheet_id = ? AND user_id = ? AND status IN ('pending','running','paused')`)
    .all(sheetId, userId) as Array<HttpRunWrites & { id: string }>;
  for (const r of http) {
    const holds = new Set<string>();
    addHttpRunColumns(r, holds);
    let config: HTTPAPIConfig | null = null;
    try { config = JSON.parse(r.config ?? 'null') as HTTPAPIConfig | null; } catch { /* reads nothing */ }
    const reads = config?.requestConfig
      ? named(requestRunInputColumns(config, r.master_column_name ?? '', columns)) : [];
    nodes.push({ key: runKey('http', r.id), reads, holds });
  }
  return nodes;
}

// The ring from run `key` back to it, as the columns it waits on in turn: the first is one `key` reads (the
// next run fills it), the last one `key` fills (the run before it reads it). null: no ring through `key`.
export function waitRing(sheetId: string, userId: string, key: string): string[] | null {
  const nodes = goingRuns(sheetId, userId);
  const self = nodes.find(n => n.key === key);
  if (!self) return null;
  const seen = new Set([key]);
  const walk = (at: Node, path: string[]): string[] | null => {
    for (const next of nodes) {
      if (next.key === at.key) continue;
      const column = at.reads.find(c => next.holds.has(c));
      if (column === undefined) continue;
      if (next.key === key) return [...path, column];
      if (seen.has(next.key)) continue;
      seen.add(next.key);
      const found = walk(next, [...path, column]);
      if (found) return found;
    }
    return null;
  };
  return walk(self, []);
}

// What a row of a run in the ring is failed with, from its own column on: "Score" (this run fills it) waits for
// "Answer" (it reads it) to finish filling, "Answer" for the next, and the last for "Score".
export function ringWords(ring: string[]): string {
  const l = [ring[ring.length - 1], ...ring.slice(0, -1)];
  const first = `"${l[0]}" waits for "${l[1]}" to finish filling`;
  const middle = l.slice(1, -1).map((c, i) => `"${c}" for "${l[i + 2]}"`).join(', ');
  const rest = l.length === 2 ? `, and "${l[1]}" waits for "${l[0]}"`
    : `, ${middle}, and "${l[l.length - 1]}" for "${l[0]}"`;
  return `${first}${rest}: ${l.length === 2 ? 'neither' : 'none of them'} can finish. Run them again one at a time.`;
}
