// What a running row does while a column it reads is held by another run (services/run-input-gate.ts), from the
// runs going on the sheet (pending, running or paused; a parked run is pending), each by what it reads
// (lib/run-inputs/columns.ts) and what it holds (lib/run-locked-columns.ts). A run that ended and is still
// putting its ⏳ cells back waits for nothing and needs no job slot, so it ends every chain. Runs only read their
// own sheet.
//   - A ring (runs that each wait for the next, back to this one) could never finish: its newest run that isn't
//     paused fails the rows that would wait, so the others finish (a paused one can't resume while a column it
//     reads is held, lib/run-resume-inputs.ts, so it can't break the ring).
//   - A chain that reaches a run that can't go on in a job slot (queued, parked or paused) parks this one: it
//     gives its slot back (lib/run-park.ts), or runs waiting for queued ones could take every slot.
//   - Otherwise every run it waits for is running: it waits in place.
import { db } from './db';
import { getSheetColumns } from './sql-helpers';
import { addAiRunColumns, addHttpRunColumns, type AiRunWrites, type HttpRunWrites } from './run-locked-columns';
import { aiRunInputColumns, requestRunInputColumns, type AiInputFields } from './run-inputs/columns';
import type { HTTPAPIConfig } from './http-request-template';

export type RunKind = 'ai' | 'http';
interface Node { key: string; status: string; createdAt: string; reads: string[]; holds: Set<string> }
export const runKey = (kind: RunKind, id: string): string => `${kind}:${id}`;
// ring: the words its rows fail with; park: why it gives its slot back (what the chain reached).
export type WaitPlan = { ring: string } | { park: 'queued' | 'paused' } | null;
type Going = { id: string; status: string; created_at: string };

const named = (list: Array<string | null>): string[] => list.filter((c): c is string => c !== null);

function goingRuns(sheetId: string, userId: string): Node[] {
  const columns = getSheetColumns(sheetId, userId, false);
  const nodes: Node[] = [];
  const node = (kind: RunKind, r: Going, reads: string[], holds: Set<string>): Node =>
    ({ key: runKey(kind, r.id), status: r.status, createdAt: r.created_at, reads, holds });
  const ai = db.prepare(`SELECT id, status, created_at, column_name, prompt, output_columns, data_column,
    use_openrouter_web_search FROM ai_runs
    WHERE sheet_id = ? AND user_id = ? AND status IN ('pending','running','paused')`)
    .all(sheetId, userId) as Array<AiInputFields & AiRunWrites & Going>;
  for (const r of ai) {
    const holds = new Set<string>();
    addAiRunColumns(r, holds);
    nodes.push(node('ai', r, named(aiRunInputColumns(r, columns)), holds));
  }
  const http = db.prepare(`SELECT id, status, created_at, config, master_column_name FROM http_runs
    WHERE sheet_id = ? AND user_id = ? AND status IN ('pending','running','paused')`)
    .all(sheetId, userId) as Array<HttpRunWrites & Going>;
  for (const r of http) {
    const holds = new Set<string>();
    addHttpRunColumns(r, holds);
    let config: HTTPAPIConfig | null = null;
    try { config = JSON.parse(r.config ?? 'null') as HTTPAPIConfig | null; } catch { /* reads nothing */ }
    const reads = config?.requestConfig
      ? named(requestRunInputColumns(config, r.master_column_name ?? '', columns)) : [];
    nodes.push(node('http', r, reads, holds));
  }
  return nodes;
}

// The runs `at` waits for, each with the column it reads that the other holds.
const waitsFor = (nodes: Node[], at: Node): Array<{ next: Node; column: string }> => nodes.flatMap(next => {
  const column = next.key === at.key ? undefined : at.reads.find(c => next.holds.has(c));
  return column === undefined ? [] : [{ next, column }];
});

// The ring through `self`: its runs and the columns each waits on in turn (the first one `self` reads).
function ringOf(nodes: Node[], self: Node): { runs: Node[]; columns: string[] } | null {
  const seen = new Set([self.key]);
  const walk = (at: Node, runs: Node[], columns: string[]): { runs: Node[]; columns: string[] } | null => {
    for (const { next, column } of waitsFor(nodes, at)) {
      if (next.key === self.key) return { runs, columns: [...columns, column] };
      if (seen.has(next.key)) continue;
      seen.add(next.key);
      const found = walk(next, [...runs, next], [...columns, column]);
      if (found) return found;
    }
    return null;
  };
  return walk(self, [self], []);
}

const newer = (a: Node, b: Node): boolean =>
  a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.key > b.key);

export function waitPlan(sheetId: string, userId: string, key: string): WaitPlan {
  const nodes = goingRuns(sheetId, userId);
  const self = nodes.find(n => n.key === key);
  if (!self) return null;
  const ring = ringOf(nodes, self);
  if (ring) {
    const able = ring.runs.filter(n => n.status !== 'paused');
    const newest = able.reduce((a, b) => (newer(b, a) ? b : a), able[0]);
    if (newest.key === self.key) return { ring: ringWords(ring.columns) };
  }
  // Everything it waits for, run by run down the chain.
  const seen = new Set([self.key]);
  const queue = [self];
  let paused = false;
  while (queue.length > 0) {
    for (const { next } of waitsFor(nodes, queue.shift()!)) {
      if (seen.has(next.key)) continue;
      seen.add(next.key);
      if (next.status === 'pending') return { park: 'queued' };
      if (next.status === 'paused') paused = true;
      else queue.push(next);
    }
  }
  return paused ? { park: 'paused' } : null;
}

// What a row of the run that fails is told, from its own column on: "Score" (this run fills it) waits for
// "Answer" (it reads it) to finish filling, "Answer" for the next, and the last for "Score".
export function ringWords(ring: string[]): string {
  const l = [ring[ring.length - 1], ...ring.slice(0, -1)];
  const first = `"${l[0]}" waits for "${l[1]}" to finish filling`;
  const middle = l.slice(1, -1).map((c, i) => `"${c}" for "${l[i + 2]}"`).join(', ');
  const rest = l.length === 2 ? `, and "${l[1]}" waits for "${l[0]}"`
    : `, ${middle}, and "${l[l.length - 1]}" for "${l[0]}"`;
  return `${first}${rest}: ${l.length === 2 ? 'neither' : 'none of them'} could finish, so this run, the newest, `
    + `failed the rows that would wait. Run them again once "${ring[0]}" is filled.`;
}
