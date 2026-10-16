// The order of a setup's steps (pure). A step reads columns (refs.ts) and
// makes columns (spec.ts stepColumns); it comes after every step that makes a
// column it reads. Columns no step makes are the setup's inputs. Two steps
// making one column (names ignore case, as a sheet's do), or a step reading
// its own column down a chain, are refused. layer: when the step can start
// (0 = from the inputs alone; n = after its deepest dependency, at n - 1).
export interface GraphStep { label: string; makes: string[]; reads: string[] }

export type Ordered =
  | { ok: { order: number[]; layers: number[]; inputs: string[]; dependsOn: number[][] } }
  | { problem: string };

export function orderSteps(steps: GraphStep[]): Ordered {
  const maker = new Map<string, number>();
  for (const [i, s] of steps.entries()) {
    for (const c of s.makes) {
      const key = c.toLowerCase();
      const other = maker.get(key);
      if (other !== undefined && other !== i) {
        return { problem: `${steps[other].label} and ${s.label} both make a column named "${c}".` };
      }
      maker.set(key, i);
    }
  }
  const inputs: string[] = [];
  const dependsOn = steps.map(s => {
    const deps = new Set<number>();
    for (const c of s.reads) {
      const m = maker.get(c.toLowerCase());
      if (m === undefined) { if (!inputs.includes(c)) inputs.push(c); continue; }
      deps.add(m);
    }
    return [...deps].sort((a, b) => a - b);
  });
  const selfRead = dependsOn.findIndex((d, i) => d.includes(i));
  if (selfRead >= 0) return { problem: `${steps[selfRead].label} reads a column it makes itself.` };

  // Kahn's order, lowest index first among the ready ones: the saved order is
  // kept wherever the reads allow it.
  const layers = steps.map(() => -1);
  const order: number[] = [];
  while (order.length < steps.length) {
    const ready = steps.findIndex((_, i) => layers[i] < 0 && dependsOn[i].every(d => layers[d] >= 0));
    if (ready < 0) {
      const stuck = steps.filter((_, i) => layers[i] < 0).map(s => s.label);
      return { problem: `These steps read each other's columns in a loop: ${stuck.join(', ')}.` };
    }
    layers[ready] = dependsOn[ready].reduce((m, d) => Math.max(m, layers[d] + 1), 0);
    order.push(ready);
  }
  return { ok: { order, layers, inputs, dependsOn } };
}
