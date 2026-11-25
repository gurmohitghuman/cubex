// The order a column run takes its columns in (pure; services/column-run-plan.ts).
// A chosen column waits for every chosen column whose values it reads, read
// directly or through clean, formula and lookup columns in between (those
// follow their columns on their own: the step also waits until they have
// caught up, so it never reads one still showing the old answer). Each column
// goes in the layer after the last one it waits for; two columns that read
// each other's values can't be ordered and are refused. changes: every
// column the run may change, the chosen columns' own and the derived columns
// worked out from them, which a `where` may not read (its rows would move
// while the run goes).

export interface OrderColumn {
  main: string;     // the run's main column
  writes: string[]; // every column its run writes (main first)
  reads: string[];  // the columns its newest run reads: request or prompt, and its "Only run if" rule
}

export interface ColumnOrder {
  layers: number[];    // each column's layer, 0 first
  waitsFor: number[][]; // the chosen columns each one waits for (indexes)
  between: string[][]; // the derived columns each one reads its earlier columns through
  changes: string[];
}

export type OrderResult = { ok: ColumnOrder } | { problem: string };

// derived: each clean, formula and lookup column of the sheet → the columns it reads.
export function orderColumns(chosen: OrderColumn[], derived: ReadonlyMap<string, readonly string[]>): OrderResult {
  const writer = new Map<string, number>();
  chosen.forEach((c, i) => c.writes.forEach(w => writer.set(w, i)));

  // Which chosen columns `column` is worked out from, and the derived columns on the way (memoised).
  const memo = new Map<string, { from: Set<number>; via: Set<string> }>();
  const trace = (column: string, seen: Set<string>): { from: Set<number>; via: Set<string> } => {
    const known = memo.get(column);
    if (known) return known;
    const out = { from: new Set<number>(), via: new Set<string>() };
    const w = writer.get(column);
    if (w !== undefined) out.from.add(w);
    else if (derived.has(column) && !seen.has(column)) {
      seen.add(column);
      for (const input of derived.get(column)!) {
        const t = trace(input, seen);
        t.from.forEach(i => out.from.add(i));
        t.via.forEach(v => out.via.add(v));
      }
      seen.delete(column);
      if (out.from.size) out.via.add(column);
    }
    memo.set(column, out);
    return out;
  };

  const waitsFor = chosen.map(() => [] as number[]);
  const between = chosen.map(() => [] as string[]);
  chosen.forEach((c, i) => {
    const from = new Set<number>(), via = new Set<string>();
    for (const r of c.reads) {
      const t = trace(r, new Set());
      t.from.forEach(j => { if (j !== i) from.add(j); });
      t.via.forEach(v => via.add(v));
    }
    waitsFor[i] = [...from].sort((a, b) => a - b);
    between[i] = [...via];
  });

  const layers = chosen.map(() => -1);
  const state = chosen.map(() => 0); // 0 unvisited, 1 on the path, 2 placed
  let loop = null as [number, number] | null; // set inside place(): typed so the check below sees it
  const place = (i: number): number => {
    if (state[i] === 2) return layers[i];
    state[i] = 1;
    let layer = 0;
    for (const j of waitsFor[i]) {
      if (state[j] === 1) { loop ??= [j, i]; continue; }
      layer = Math.max(layer, place(j) + 1);
    }
    state[i] = 2;
    layers[i] = layer;
    return layer;
  };
  chosen.forEach((_, i) => place(i));
  if (loop) {
    const [a, b] = loop;
    return { problem: `"${chosen[a].main}" and "${chosen[b].main}" each read what the other fills, so neither `
      + 'can go first. Run them in two column runs, one after the other.' };
  }

  const changes = new Set(chosen.flatMap(c => c.writes));
  for (const column of derived.keys()) if (trace(column, new Set()).from.size) changes.add(column);
  return { ok: { layers, waitsFor, between, changes: [...changes] } };
}
