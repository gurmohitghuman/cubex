// What a column restore answers (services/trash-restore-column.ts): the name it came back under and why,
// its cells (back, skipped: rows gone, kept: rows holding a value there now), its setup, what didn't come
// back with it (references_dropped), and notes saying what happened and what to do next.
import { countOf } from '../lib/change-log';
import type { TrashItem } from '../lib/trash/store';
import { droppedRefsOf } from '../lib/trash/column-restore';
import { droppedEntry, stillDropped, type DroppedEntry, type RefSurface } from '../lib/trash/column-refs-words';
import { setupWords, type SetupPlan } from './trash-restore-column-setup';
import type { Finished } from './trash-restore-column-finish';

export interface ColumnRestored {
  trash_id: number; kind: 'column'; sheet_id: string; state: 'restored' | 'restoring';
  name: string; old_name: string; renamed: boolean; position: number | null;
  cells: number; cells_restored: number; cells_skipped: number; cells_kept: number;
  setup: { kind: SetupPlan['kind']; restored: boolean; run_id: string | null; note: string };
  references_dropped: DroppedEntry[];
  note?: string;
}

export function answerOf(item: TrashItem, name: string, into: boolean, state: ColumnRestored['state'],
  done: Finished | null, surface: RefSurface, planned: SetupPlan | null): ColumnRestored {
  const old = item.column_name!;
  const renamed = name !== old;
  const plan = done?.plan ?? planned ?? { kind: 'plain' as const, problem: null, taken: [] };
  const refs = into ? [] : [...droppedRefsOf(item).filter(r => stillDropped(r, renamed)), ...plan.taken];
  const left = done?.skipped ?? 0;
  const kept = done?.kept ?? 0;
  // Leftovers of an earlier restore whose column is gone or renamed since: a column of their own.
  const away = !into && item.restore_name !== null;
  const notes = [
    ...(renamed && !into ? [`Its name "${old}" was taken, so it came back as "${name}". Setups that name "${old}" `
      + `(prompts, formulas, requests, clean and lookup columns) read the column now called "${old}".`] : []),
    ...(away ? [`The column its other cells went back to, "${item.restore_name}", is gone or renamed, so these `
      + `came back as a column of their own, "${name}", with the setup the column had.`] : []),
    ...(into ? [`These cells' rows were gone or held a value when "${old}" came back${renamed ? ` as "${name}"`
      : ''}; they went into it now.`] : []),
    ...(left ? [`${countOf(left, 'cell')} stayed in the trash (trash_id ${item.id}): their rows are gone, maybe `
      + `in the trash too. Once those rows are back, restore it again and they go into "${name}".`] : []),
    ...(kept ? [`${countOf(kept, 'cell')} stayed in the trash (trash_id ${item.id}): their rows hold a value in `
      + `"${name}" now, which a restore never overwrites. Empty those cells and restore it again to put them `
      + 'back.'] : []),
    ...(state === 'restoring' ? [`Its ${countOf(item.row_count, 'cell')} are going back in the background, and `
      + 'the column shows once they are all back (the trash shows how far it got).'] : []),
  ];
  const setupNote = into ? `Its setup came back with "${name}" already.`
    : done || plan.kind === 'plain' || plan.problem ? setupWords(plan, done?.runId ?? null, surface)
      : 'Its setup comes back with it once all its cells are back; nothing runs.';
  return {
    trash_id: item.id, kind: 'column', sheet_id: item.sheet_id!, state, name, old_name: old, renamed,
    position: done?.position ?? null, cells: item.row_count, cells_restored: done?.restored ?? 0,
    cells_skipped: left, cells_kept: done?.kept ?? 0,
    setup: { kind: plan.kind, restored: !into && plan.kind !== 'plain' && plan.problem === null && done !== null,
      run_id: done?.runId ?? null, note: setupNote },
    references_dropped: refs.map(r => droppedEntry(r, name, old, surface, item.sheet_id!)),
    ...(notes.length ? { note: notes.join(' ') } : {}),
  };
}
