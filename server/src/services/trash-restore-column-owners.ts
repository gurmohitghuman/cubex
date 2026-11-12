// A restored column's own setup may write into other columns: an AI column's outputs and its "(Data)" column,
// an HTTP API, enrichment or waterfall column's fields. One that another setup fills now stays with that setup,
// by the rule a setup version's restore follows (lib/setup-versions/own.ts): the HTTP setup comes back without
// that field, the AI setup without that output. An AI setup comes back plain when none of its outputs is left,
// or when its "(Data)" column is another's (its web search would write there). Each one is listed in the
// restore's references_dropped (output_taken) with the column whose setup fills it now. Reads setups only.
import { columnKinds, fillMakes, KIND_WORDS, mappedColumns, type Fill } from '../lib/setup-versions/spec';
import { ownsColumn, withoutFields, withoutOutputs } from '../lib/setup-versions/own';
import type { DroppedRef } from '../lib/trash/column-refs';
import { listOf, notMineWhy } from './setup-version-plan-words';
import { snapshotSheet } from './setup-version-snapshot';

export type Taken = Extract<DroppedRef, { kind: 'output_taken' }>;
// fill: what to write (without what isn't its own now); problem: why it comes back plain.
export interface Owned { fill: Fill; taken: Taken[]; problem: string | null }

// `name`: the name the column comes back under (no column has it now).
export function ownedFill(sheetId: string, userId: string, name: string, f: Fill): Owned {
  if (f.kind !== 'ai' && f.kind !== 'http') return { fill: f, taken: [], problem: null };
  const now = snapshotSheet(sheetId, userId);
  const nowKinds = columnKinds(now);
  const has = new Set(now.columns.map(c => c.name));
  const makes = (f.kind === 'http' ? mappedColumns(f.config) : fillMakes(f, name)).filter(c => c !== name);
  // Every column it writes was its own. One the sheet hasn't got now its run adds again, as a version's
  // restore adds a column back.
  const was = columnKinds({ v: 1, columns: [
    { name, description: null, autoRun: null, fill: f.kind === 'http' ? { ...f, extracted: makes } : f },
    ...makes.map(c => ({ name: c, description: null, fill: null, autoRun: null }))] });
  const owners = { back: new Set(makes.filter(c => !has.has(c))), exists: (c: string) => has.has(c), was,
    now: nowKinds };
  const gone = makes.filter(c => !ownsColumn(name, c, owners));
  if (gone.length === 0) return { fill: f, taken: [], problem: null };
  const why = (c: string) => notMineWhy(false, true, nowKinds.get(c)?.kind, nowKinds.get(c)?.by);
  const taken = gone.map((c): Taken => {
    const owner = nowKinds.get(c)?.by ?? c;
    const m = f.kind === 'http' ? (f.config.responseMapping as any[]).find(x => x?.columnName === c) : null;
    return { kind: 'output_taken', column: c, mode: f.kind === 'http' ? f.mode : 'ai',
      path: typeof m?.jsonPath === 'string' ? m.jsonPath : null, owner,
      owner_kind: KIND_WORDS[nowKinds.get(owner)?.kind ?? 'plain'], now: why(c) };
  });
  if (f.kind === 'http') return { fill: withoutFields(f, gone), taken, problem: null };
  const outputs = (f.outputColumns ?? []).map(o => o.columnName);
  const data = makes.find(c => !outputs.includes(c));
  if (data && gone.includes(data)) {
    return { fill: f, taken, problem: `its web sources go to "${data}", which ${why(data)}` };
  }
  const left = withoutOutputs(f, gone);
  if (!left.outputColumns?.length) {
    return { fill: f, taken, problem: `every column it puts its answers in is another setup's now: `
      + gone.map(c => `"${c}" ${why(c)}`).join('; ') };
  }
  return { fill: left, taken, problem: null };
}

// What the setup note says about the columns it came back without.
export function withoutWords(taken: Taken[]): string {
  const cols = taken.map(t => t.column);
  const what = taken[0]?.mode === 'ai' ? `the output${cols.length === 1 ? '' : 's'} ${listOf(cols)}`
    : `the field${cols.length === 1 ? '' : 's'} it put in ${listOf(cols)}`;
  return `without ${what} (${taken.map(t => `"${t.column}" ${t.now}`).join('; ')}: `
    + `${cols.length === 1 ? 'it stays' : 'they stay'} with that setup)`;
}
