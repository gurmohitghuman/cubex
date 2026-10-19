// Loops of derived columns (clean, formula and lookup columns, services/derived-kind.ts):
// a column worked out, directly or down a chain, from itself would follow its
// own writes forever, so saving one and renaming a column both check. The
// graph is column → the columns it reads, from both kinds' records. Records
// count even for columns not in the sheet now (a deleted input keeps its
// record), so a column made or renamed later under that name can't close one.
import { db } from './db';

type Graph = Map<string, string[]>;

function inputsOf(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

function derivedGraph(sheetId: string, userId: string): Graph {
  const graph: Graph = new Map();
  const clean = db.prepare(`SELECT column_name AS c, source_column AS s FROM clean_columns
    WHERE sheet_id = ? AND user_id = ?`).all(sheetId, userId) as Array<{ c: string; s: string }>;
  for (const r of clean) graph.set(r.c, [r.s]);
  const formula = db.prepare(`SELECT column_name AS c, inputs AS i FROM formula_columns
    WHERE sheet_id = ? AND user_id = ?`).all(sheetId, userId) as Array<{ c: string; i: string }>;
  for (const r of formula) graph.set(r.c, inputsOf(r.i));
  // A lookup reads one column of its own row (what it reads in another sheet
  // never works it out again, so no loop can run through there).
  const lookup = db.prepare(`SELECT column_name AS c, source_column AS s FROM lookup_columns
    WHERE sheet_id = ? AND user_id = ?`).all(sheetId, userId) as Array<{ c: string; s: string }>;
  for (const r of lookup) graph.set(r.c, [r.s]);
  return graph;
}

// The chain from one of `starts` back to `target` (each step a column the
// previous one reads), or null.
function pathTo(graph: Graph, starts: string[], target: string): string[] | null {
  const seen = new Set<string>();
  const walk = (at: string, path: string[]): string[] | null => {
    if (at === target) return path;
    if (seen.has(at)) return null;
    seen.add(at);
    for (const next of graph.get(at) ?? []) {
      const found = walk(next, [...path, next]);
      if (found) return found;
    }
    return null;
  };
  for (const s of starts) {
    const found = walk(s, [s]);
    if (found) return found;
  }
  return null;
}

// Whether `column` reading `inputs` would close a loop: "Y ← X ← column", the
// chain from an input back to the column, or null.
export function derivedLoopThrough(sheetId: string, userId: string, column: string, inputs: string[]): string | null {
  const graph = derivedGraph(sheetId, userId);
  graph.set(column, inputs);
  return pathTo(graph, inputs, column)?.join(' ← ') ?? null;
}

// Whether renaming a column would close a loop (a record can read a column
// that's gone; one renamed to that name would join the chain): a column the
// loop runs through, or null.
export function derivedRenameLoop(sheetId: string, userId: string, oldName: string, newName: string): string | null {
  const to = (c: string) => (c === oldName ? newName : c);
  const graph: Graph = new Map();
  for (const [c, ins] of derivedGraph(sheetId, userId)) graph.set(to(c), ins.map(to));
  for (const [column, ins] of graph) {
    if (pathTo(graph, ins, column)) return column;
  }
  return null;
}

// Whether giving several columns their inputs at once (a setup version's
// restore) closes a loop: the first column that would, with its chain, or null.
export function derivedLoopWith(
  sheetId: string, userId: string, inputs: ReadonlyMap<string, string[]>,
): { column: string; chain: string } | null {
  const graph = derivedGraph(sheetId, userId);
  for (const [column, ins] of inputs) graph.set(column, ins);
  for (const [column, ins] of inputs) {
    const path = pathTo(graph, ins, column);
    if (path) return { column, chain: path.join(' ← ') };
  }
  return null;
}
