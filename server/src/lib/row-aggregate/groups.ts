// An aggregate read's groups (pure), built from many partial answers: SQLite
// groups one slice of rows at a time (services/row-aggregate.ts) and each
// slice's groups are added here, so only groups, never rows, are held. The
// answer keeps the AGGREGATE_TOP_GROUPS largest groups by row count.
import { createHash } from 'crypto';
import { AGGREGATE_MAX_GROUPS, GROUP_VALUE_MAX_CHARS } from '../constants-query';
import { aggregateName, type AggregateSpec } from './spec';

// What SQL measures per group: a sum, how many cells were numbers, the
// smallest and largest number, how many cells weren't empty.
export type MeasureKind = 'sum' | 'num' | 'min' | 'max' | 'filled';
export interface Measure { kind: MeasureKind; column: string }

export function measuresFor(spec: AggregateSpec): Measure[] {
  const out: Measure[] = [];
  const need = (kind: MeasureKind, column: string) => {
    if (!out.some(m => m.kind === kind && m.column === column)) out.push({ kind, column });
  };
  for (const a of spec.aggregates) {
    if (a.column === undefined) continue;
    if (a.op === 'count') need('filled', a.column);
    else if (a.op === 'avg') { need('sum', a.column); need('num', a.column); }
    else need(a.op, a.column);
  }
  return out;
}

// One group of one slice, as SQL answers it: its key per group_by column
// (the folded text), a value as written (the smallest in the slice), its row
// count and one number (or null) per measure.
export interface SliceGroup { keys: string[]; labels: unknown[]; n: number; m: Array<number | null> }

interface Group { key: string; labels: string[]; cut: boolean; n: number; m: Array<number | null> }

const cutText = (v: string) => (v.length > GROUP_VALUE_MAX_CHARS ? `${v.slice(0, GROUP_VALUE_MAX_CHARS)}…` : v);
// A long value is kept as a hash of its whole text, so two that start alike stay apart.
const keyPart = (k: string) => (k.length > GROUP_VALUE_MAX_CHARS
  ? `#${createHash('sha256').update(k).digest('base64')}` : `=${k}`);

const merge = (kind: MeasureKind, a: number | null, b: number | null): number | null => {
  if (a === null) return b;
  if (b === null) return a;
  return kind === 'min' ? Math.min(a, b) : kind === 'max' ? Math.max(a, b) : a + b;
};

export class GroupTally {
  private groups = new Map<string, Group>();
  rows = 0;
  constructor(private readonly measures: Measure[]) {}

  // false: more than AGGREGATE_MAX_GROUPS different groups (the read stops).
  add(g: SliceGroup): boolean {
    this.rows += g.n;
    const key = JSON.stringify(g.keys.map(k => keyPart(k ?? '')));
    const labels = g.labels.map(l => (l === null || l === undefined ? '' : String(l).trim()));
    const had = this.groups.get(key);
    if (!had) {
      if (this.groups.size >= AGGREGATE_MAX_GROUPS) return false;
      const cut = labels.some(l => l.length > GROUP_VALUE_MAX_CHARS);
      this.groups.set(key, { key, labels: labels.map(cutText), cut, n: g.n, m: [...g.m] });
      return true;
    }
    had.n += g.n;
    had.m = had.m.map((v, i) => merge(this.measures[i].kind, v, g.m[i]));
    // The smallest value as written, whichever slice saw it.
    labels.forEach((l, i) => { const c = cutText(l); if (c < had.labels[i]) had.labels[i] = c; });
    return true;
  }

  get size(): number { return this.groups.size; }

  // Rows whose every group_by cell is empty (folded), wherever that group ranks.
  emptyRows(groupBy: number): number {
    return this.groups.get(JSON.stringify(Array.from({ length: groupBy }, () => keyPart(''))))?.n ?? 0;
  }

  // The largest groups (ties by value), each with its aggregates by name.
  result(spec: AggregateSpec, top: number) {
    const measure = (g: Group, kind: MeasureKind, column: string) =>
      g.m[this.measures.findIndex(m => m.kind === kind && m.column === column)] ?? null;
    const values = (g: Group): Record<string, number | null> => Object.fromEntries(spec.aggregates.map(a => {
      if (a.column === undefined) return [aggregateName(a), g.n];
      if (a.op === 'count') return [aggregateName(a), measure(g, 'filled', a.column) ?? 0];
      if (a.op === 'avg') {
        const n = measure(g, 'num', a.column) ?? 0;
        return [aggregateName(a), n > 0 ? (measure(g, 'sum', a.column) ?? 0) / n : null];
      }
      return [aggregateName(a), measure(g, a.op, a.column)];
    }));
    const all = [...this.groups.values()]
      .filter(g => spec.groupBy.length === 0 || g.n > 0)
      .sort((a, b) => b.n - a.n || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const groups = all.slice(0, top).map(g => ({
      group: Object.fromEntries(spec.groupBy.map((c, i) => [c, g.labels[i]])),
      count: g.n,
      ...(spec.aggregates.length ? { values: values(g) } : {}),
      ...(g.cut ? { cut: true } : {}),
    }));
    return { rows_matched: this.rows, group_count: all.length, truncated: all.length > top, groups };
  }
}
