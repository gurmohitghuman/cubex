// A column rename inside a setup version (pure), as a rename rewrites the
// sheet's live records: the column itself, and every reference to it (an AI
// prompt's /token, a request's {{column}}, a formula's {{column}}, a clean or
// lookup column's source, "Only run if" rules, auto-run's conditions). A
// version naming both the column and one deleted since under the new name
// loses the deleted one's entry: the name is the renamed column's now. Another sheet's
// rename reaches the lookups looking in it, a waterfall's lookup steps and a
// list enrichment adding rows to it. Both mutate the spec; true when anything changed.
import { renamePromptColumnRefs } from '../column-ref-rename';
import { renameRuleColumn } from '../run-condition';
import { renameFormulaRefs } from '../formula/refs';
import { renameHttpConfigColumn } from '../http-config-rename';
import type { Fill, VersionSpec } from './spec';

const swap = (v: string, oldName: string, newName: string) => (v === oldName ? newName : v);

function renameFill(f: Fill, oldName: string, newName: string): boolean {
  const before = JSON.stringify(f);
  switch (f.kind) {
    case 'ai':
      f.prompt = renamePromptColumnRefs(f.prompt, oldName, newName);
      if (f.runIf) f.runIf = renameRuleColumn(f.runIf, oldName, newName);
      if (f.outputColumns) {
        f.outputColumns = f.outputColumns.map(o => ({ ...o, columnName: swap(o.columnName, oldName, newName) }));
      }
      if (f.dataColumn) f.dataColumn = swap(f.dataColumn, oldName, newName);
      break;
    case 'http':
      renameHttpConfigColumn(f.config, oldName, newName);
      f.extracted = f.extracted.map(c => swap(c, oldName, newName));
      break;
    case 'clean':
      f.source = swap(f.source, oldName, newName);
      break;
    case 'formula':
      f.formula = renameFormulaRefs(f.formula, oldName, newName);
      break;
    case 'lookup':
      f.source = swap(f.source, oldName, newName);
      break;
  }
  return JSON.stringify(f) !== before;
}

export function renameVersionColumn(spec: VersionSpec, oldName: string, newName: string): boolean {
  if (oldName === newName) return false;
  let changed = false;
  // The name is the renamed column's now: an entry for a column deleted since goes.
  if (spec.columns.some(c => c.name === oldName) && spec.columns.some(c => c.name === newName)) {
    spec.columns = spec.columns.filter(c => c.name !== newName);
    changed = true;
  }
  for (const c of spec.columns) {
    if (c.name === oldName) { c.name = newName; changed = true; }
    if (c.fill && renameFill(c.fill, oldName, newName)) changed = true;
    if (c.autoRun) {
      const a = JSON.stringify(c.autoRun);
      c.autoRun.where = c.autoRun.where.map(w => ({ ...w, column: swap(w.column, oldName, newName) }));
      if (c.autoRun.runIf) c.autoRun.runIf = renameRuleColumn(c.autoRun.runIf, oldName, newName);
      if (JSON.stringify(c.autoRun) !== a) changed = true;
    }
  }
  return changed;
}

// A column of ANOTHER sheet (otherSheetId) renamed.
export function renameOtherSheetColumn(
  spec: VersionSpec, otherSheetId: string, oldName: string, newName: string,
): boolean {
  let changed = false;
  for (const c of spec.columns) {
    const f = c.fill;
    if (f?.kind === 'lookup' && f.otherSheetId === otherSheetId) {
      const before = JSON.stringify(f);
      f.matchColumn = swap(f.matchColumn, oldName, newName);
      if (f.returnColumns) f.returnColumns = f.returnColumns.map(r => swap(r, oldName, newName));
      if (JSON.stringify(f) !== before) changed = true;
    }
    if (f?.kind !== 'http') continue;
    for (const s of Array.isArray(f.config.waterfall?.steps) ? f.config.waterfall.steps : []) {
      const ch = s?.choices;
      if (ch?.kind !== 'lookup' || ch.sheetId !== otherSheetId) continue;
      if (ch.matchColumn === oldName) { ch.matchColumn = newName; changed = true; }
      if (ch.returnColumn === oldName) { ch.returnColumn = newName; changed = true; }
    }
    const list = f.destSheetId === otherSheetId ? f.config.enrichment?.list : null;
    if (!list || typeof list !== 'object') continue;
    for (const x of Array.isArray(list.fields) ? list.fields : []) {
      if (x?.columnName === oldName) { x.columnName = newName; changed = true; }
    }
    for (const x of Array.isArray(list.copy) ? list.copy : []) {
      if (x?.to === oldName) { x.to = newName; changed = true; }
    }
  }
  return changed;
}
