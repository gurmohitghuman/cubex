// A setup version against the sheet as it is now (pure): which columns the
// version names that are gone (a restore adds them back, empty), which the
// sheet has that the version doesn't (a restore keeps them), which are set up
// differently (field by field: fields.ts), and which are filled another way
// now (a restore can't turn one kind of column into another: it leaves them).
// The column order a restore leaves comes from mergeOrder.
import { autoRunWords, canonical, fillChanges, type FieldChange, type FieldContext } from './fields';
import { columnKinds, type ColumnKind, type VersionColumn, type VersionSpec } from './spec';

export interface ColumnChange {
  column: string;
  change: 'missing' | 'added' | 'changed' | 'kind';
  kind: ColumnKind;          // as the version has it ('added': as the sheet has it)
  nowKind?: ColumnKind;      // 'kind': as the sheet has it
  fields: FieldChange[];     // 'changed' and 'kind': what differs
}

export interface VersionDiff {
  columns: ColumnChange[];   // version order, then the sheet's own
  unchanged: number;
  order: { changed: boolean; after: string[] };
}

export const autoRunKey = (c: VersionColumn) => canonical(c.autoRun ?? null);

function columnFields(v: VersionColumn, n: VersionColumn, sameKind: boolean, ctx: FieldContext): FieldChange[] {
  const out: FieldChange[] = [];
  if (sameKind && v.fill && n.fill) out.push(...fillChanges(v.fill, n.fill, ctx));
  if (sameKind && autoRunKey(v) !== autoRunKey(n)) {
    out.push({ field: 'Auto-run', version: autoRunWords(v.autoRun), now: autoRunWords(n.autoRun) });
  }
  if ((v.description ?? null) !== (n.description ?? null)) {
    out.push({ field: 'Description', version: v.description, now: n.description });
  }
  return out;
}

export function diffVersion(version: VersionSpec, now: VersionSpec, ctx: FieldContext): VersionDiff {
  const vk = columnKinds(version), nk = columnKinds(now);
  const nowBy = new Map(now.columns.map(c => [c.name, c]));
  const inVersion = new Set(version.columns.map(c => c.name));
  const columns: ColumnChange[] = [];
  let unchanged = 0;
  for (const v of version.columns) {
    const n = nowBy.get(v.name);
    const kv = vk.get(v.name)!;
    if (!n) { columns.push({ column: v.name, change: 'missing', kind: kv.kind, fields: [] }); continue; }
    const kn = nk.get(v.name)!;
    // A column the version had filled by another may be plain now: restoring that one fills it again.
    const madeAgain = kv.kind === 'made' && (kn.kind === 'plain' || kn.kind === 'made');
    const sameKind = kv.kind === kn.kind && kv.kind !== 'made';
    const fields = columnFields(v, n, sameKind, ctx);
    if (madeAgain && kv.by !== kn.by) fields.unshift({ field: 'Filled by', version: kv.by, now: kn.by });
    if (!sameKind && !madeAgain && kv.kind !== kn.kind) {
      columns.push({ column: v.name, change: 'kind', kind: kv.kind, nowKind: kn.kind, fields });
    } else if (fields.length) {
      columns.push({ column: v.name, change: 'changed', kind: kv.kind, fields });
    } else {
      unchanged++;
    }
  }
  for (const n of now.columns) {
    if (inVersion.has(n.name)) continue;
    columns.push({ column: n.name, change: 'added', kind: nk.get(n.name)!.kind, fields: [] });
  }
  const after = mergeOrder(version.columns.map(c => c.name), now.columns.map(c => c.name));
  // Gone columns coming back take their place: only the order of the columns there now counts.
  const changed = after.filter(c => nowBy.has(c)).join('\n') !== now.columns.map(c => c.name).join('\n');
  return { columns, unchanged, order: { changed, after } };
}

// The order a restore leaves: the version's columns in its order, and each
// column the version doesn't have right after the one it follows now (or
// first, when it comes before every version column).
export function mergeOrder(versionOrder: string[], nowOrder: string[]): string[] {
  const inVersion = new Set(versionOrder);
  const after = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const c of nowOrder) {
    if (inVersion.has(c)) { anchor = c; continue; }
    after.set(anchor, [...(after.get(anchor) ?? []), c]);
  }
  return [...(after.get(null) ?? []), ...versionOrder.flatMap(c => [c, ...(after.get(c) ?? [])])];
}
