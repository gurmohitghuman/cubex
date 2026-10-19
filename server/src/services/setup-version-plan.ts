// What restoring a setup version would do, column by column (dry run, and the
// restore's own plan): columns the version names that are gone come back
// empty, with their setup; columns set up differently get the version's
// setup; columns the version doesn't have stay; a column filled another way
// now is left as it is (a restore never turns one kind of column into
// another), and so is a setup that would write into a column that isn't its
// own now: an AI column is left, an HTTP API column comes back without that
// field. Descriptions and the order follow the version, except on a column
// left as it is. Checks and notes: setup-version-plan-words.ts. Reads
// configs only, never a row.
import { db } from '../lib/db';
import { findColumnNameCollision, columnCollisionMessage } from '../lib/column-names';
import { compileFormula } from '../lib/formula/refs';
import { derivedLoopWith } from '../lib/derived-loops';
import { diffVersion, mergeOrder, autoRunKey } from '../lib/setup-versions/diff';
import { fillKey, NO_RERUN_FIELDS, type FieldChange, type FieldContext } from '../lib/setup-versions/fields';
import {
  columnKinds, fillMakes, mappedColumns, type ColumnKind, type Fill, type HttpFill, type VersionColumn,
  type VersionSpec,
} from '../lib/setup-versions/spec';
import { snapshotSheet } from './setup-version-snapshot';
import {
  addBackNote, fillProblem, fillReads, kindNote, listOf, notMineWhy, redoNote,
} from './setup-version-plan-words';

export type RestoreAction = 'add_back' | 'restore' | 'keep' | 'leave';
export interface PlannedColumn {
  column: string; action: RestoreAction; kind: ColumnKind; nowKind?: ColumnKind; fields: FieldChange[];
  note: string | null;
}
// What the restore writes (not shown): fills, auto-runs and descriptions by column.
export interface RestoreWrites {
  addBack: string[];
  fills: Map<string, Fill>;                 // the column's setup to write back
  autoRuns: Map<string, VersionColumn>;     // auto-run to set as the version has it
  descriptions: Map<string, string | null>;
  order: string[];
}
export interface RestorePlan {
  columns: PlannedColumn[]; unchanged: number; orderChanged: boolean; nothing: boolean; writes: RestoreWrites;
  loop: string | null;                      // a clean, formula or lookup column it would work out from itself
}

const sheetNameOf = (userId: string) => (id: string): string | null =>
  (db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL').pluck()
    .get(id, userId) as string | undefined) ?? null;

export const fieldContext = (userId: string, reveal: boolean): FieldContext =>
  ({ reveal, sheetName: sheetNameOf(userId) });

const withoutFields = (f: HttpFill, gone: string[]): HttpFill => ({ ...f, config: { ...f.config,
  responseMapping: (f.config.responseMapping ?? []).filter((m: any) => !gone.includes(m?.columnName)) } });

const derivedInputs = (f: Fill, columns: string[]): string[] | null =>
  (f.kind === 'clean' || f.kind === 'lookup' ? [f.source] : f.kind === 'formula'
    ? (() => { try { return compileFormula(f.formula, columns).inputs; } catch { return []; } })() : null);

export function planRestore(sheetId: string, userId: string, version: VersionSpec, ctx: FieldContext): RestorePlan {
  const now = snapshotSheet(sheetId, userId);
  const diff = diffVersion(version, now, ctx);
  const nBy = new Map(now.columns.map(c => [c.name, c]));
  const vk = columnKinds(version), nk = columnKinds(now);
  const nowNames = now.columns.map(c => c.name);
  const writes: RestoreWrites =
    { addBack: [], fills: new Map(), autoRuns: new Map(), descriptions: new Map(), order: [] };
  const left = new Map<string, string>();       // column → why a restore leaves it as it is
  const notes = new Map<string, string>();      // column → what else to know
  const plain = new Map<string, string>();      // column added back without its setup → why
  for (const c of diff.columns) {
    if (c.change === 'kind') left.set(c.column, kindNote(c.kind, c.nowKind!));
    if (c.change !== 'missing') continue;
    const clash = findColumnNameCollision(c.column, [...nowNames, ...writes.addBack]);
    if (clash) left.set(c.column, `It can't be added back: ${columnCollisionMessage(c.column, clash)}`);
    else writes.addBack.push(c.column);
  }
  const back = new Set(writes.addBack);
  const after = [...nowNames, ...writes.addBack];
  // A column a version's setup writes into is that setup's to write: added back
  // now, or the version had it filled by that column and nothing else fills it now.
  const mine = (owner: string, c: string) => back.has(c) || (nBy.has(c) && vk.get(c)?.kind === 'made'
    && vk.get(c)?.by === owner && (nk.get(c)!.kind === 'plain' || nk.get(c)!.by === owner));
  const why = (c: string) => notMineWhy(back.has(c), nBy.has(c), nk.get(c)?.kind, nk.get(c)?.by);
  const unlinked = new Map<string, string>();   // column an HTTP setup won't fill anymore → that column
  const dropped = new Map<string, string[]>();  // HTTP column → the columns its fields put in that aren't its now
  for (const v of version.columns) {
    if (!v.fill || left.has(v.name)) continue;
    const n = nBy.get(v.name);
    let fill = v.fill;
    const makes = (fill.kind === 'http' ? mappedColumns(fill.config) : fillMakes(fill, v.name))
      .filter(c => c !== v.name);
    const notMine = makes.filter(c => !mine(v.name, c));
    if (notMine.length && fill.kind === 'ai') {
      left.set(v.name, `Its setup can't come back: it fills "${notMine[0]}", which ${why(notMine[0])}. Rename or `
        + 'delete that column first, then restore again.');
      continue;
    }
    if (notMine.length && fill.kind === 'http') {
      fill = withoutFields(fill, notMine);
      dropped.set(v.name, notMine);
    }
    // An HTTP setup is written again too when a column it writes isn't linked to it now.
    const relink = fill.kind === 'http' && mappedColumns(fill.config).some(c => c !== v.name
      && (back.has(c) || nk.get(c)?.by !== v.name));
    if (!n?.fill || fillKey(fill) !== fillKey(n.fill) || relink) {
      const problem = fillProblem(userId, sheetId, fill, after);
      if (problem) {
        if (back.has(v.name)) plain.set(v.name, problem);
        else left.set(v.name, `Its setup can't come back: ${problem}`);
        continue;
      }
      writes.fills.set(v.name, fill);
      if (fill.kind === 'http' && n?.fill?.kind === 'http') {
        for (const c of n.fill.extracted) if (!mappedColumns(fill.config).includes(c)) unlinked.set(c, v.name);
      }
    }
    if (n ? autoRunKey(v) !== autoRunKey(n) || writes.fills.has(v.name) : !!v.autoRun) writes.autoRuns.set(v.name, v);
  }
  for (const [owner, cols] of dropped) {
    const reasons = cols.map(c => `"${c}" ${why(c)}`).join('; ');
    const what = `the field${cols.length === 1 ? '' : 's'} it put in ${listOf(cols)} (${reasons})`;
    notes.set(owner, writes.fills.has(owner) ? `It comes back without ${what}.`
      : `Apart from ${what}, it's set up as the version has it already.`);
    for (const c of cols) if (!left.has(c)) left.set(c, `"${owner}" doesn't fill it again: it ${why(c)}.`);
  }
  // A column whose filler is left can't be filled by it again either.
  for (const v of version.columns) {
    const by = vk.get(v.name)?.by;
    if (by && (left.has(by) || plain.has(by)) && !back.has(v.name) && !left.has(v.name)) {
      left.set(v.name, `"${by}" is left as it is, so it doesn't fill this column again.`);
    }
  }
  for (const v of version.columns) {
    if ((!back.has(v.name) && !nBy.has(v.name)) || left.has(v.name)) continue;
    const current = nBy.get(v.name)?.description ?? null;
    if ((v.description ?? null) !== current) writes.descriptions.set(v.name, v.description);
  }
  writes.order = mergeOrder(version.columns.map(c => c.name).filter(c => nBy.has(c) || back.has(c)), nowNames);
  // Columns added back take their place in the version's order: that's adding them, not reordering.
  const orderChanged = writes.order.filter(c => nBy.has(c)).join('\n') !== nowNames.join('\n');
  const derived = new Map<string, string[]>();
  for (const [c, f] of writes.fills) { const ins = derivedInputs(f, after); if (ins) derived.set(c, ins); }
  const found = derived.size ? derivedLoopWith(sheetId, userId, derived) : null;
  const loop = found ? `Restoring it would work "${found.column}" out from itself (${found.chain}). Change one of `
    + 'those columns first.' : null;

  const readersOf = (c: string) => version.columns.filter(v => v.fill && !left.has(v.name) && v.name !== c
    && fillReads(v.fill, after).includes(c)).map(v => v.name);
  // What a restore writes for a column: its own setup, auto-run or description, or its filler's setup filling it.
  const touched = (c: string) => {
    const by = vk.get(c)?.by;
    const f = by ? writes.fills.get(by) : undefined;
    return writes.fills.has(c) || writes.autoRuns.has(c) || writes.descriptions.has(c) || unlinked.has(c)
      || (!!f && (f.kind === 'http' ? mappedColumns(f.config) : fillMakes(f, by!)).includes(c));
  };
  const columns: PlannedColumn[] = [];
  const listed = new Set<string>();
  const add = (p: PlannedColumn) => { columns.push(p); listed.add(p.column); };
  for (const c of diff.columns) {
    const base = { column: c.column, kind: c.kind, fields: c.fields, ...(c.nowKind ? { nowKind: c.nowKind } : {}) };
    const extra = [notes.get(c.column), unlinked.has(c.column)
      ? `"${unlinked.get(c.column)}" won't fill it anymore: its restored setup doesn't pick this field. It keeps `
        + 'its values.' : undefined].filter(Boolean).join(' ') || null;
    if (left.has(c.column)) { add({ ...base, action: 'leave', note: left.get(c.column)! }); continue; }
    if (c.change === 'added') { add({ ...base, action: 'keep', note: extra }); continue; }
    if (c.change === 'missing') {
      const why = plain.get(c.column);
      const by = vk.get(c.column)?.by;
      const orphan = by && (left.has(by) || plain.has(by)) ? `"${by}" is left as it is, so it doesn't fill it. ` : '';
      add({ ...base, action: 'add_back', note: why ? `Added back as a plain column: its setup can't come back. ${why}`
        : [orphan, addBackNote(writes.fills.get(c.column) ?? null, readersOf(c.column)), extra]
          .filter(Boolean).join(' ').trim() || null });
      continue;
    }
    if (!touched(c.column)) {
      add({ ...base, action: 'leave', note: extra ?? 'A restore leaves it as it is.' });
      continue;
    }
    const f = writes.fills.get(c.column);
    const redo = f && c.fields.some(x => !NO_RERUN_FIELDS.has(x.field)) ? redoNote(f) : null;
    add({ ...base, action: 'restore', note: [redo, extra].filter(Boolean).join(' ') || null });
  }
  // Set up again without a difference shown: to fill a column again, or because a field can't come back.
  for (const [c, f] of writes.fills) {
    if (listed.has(c)) continue;
    add({ column: c, action: 'restore', kind: f.kind === 'http' ? f.mode : f.kind, fields: [],
      note: notes.get(c) ?? 'Set up again so it fills its columns again.' });
  }
  for (const [c, owner] of unlinked) {
    if (listed.has(c) || !nBy.has(c)) continue;
    add({ column: c, action: 'restore', kind: nk.get(c)!.kind, fields: [], note: `"${owner}" won't fill it `
      + 'anymore: its restored setup doesn\'t pick this field. It keeps its values.' });
  }
  const nothing = !writes.addBack.length && !writes.fills.size && !writes.autoRuns.size && !writes.descriptions.size
    && !orderChanged;
  return { columns, unchanged: diff.unchanged, orderChanged, nothing, writes, loop };
}
