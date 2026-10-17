// Seeding a run that has an "Only run if" rule (lib/run-condition.ts): like
// seedProcessingPlaceholders (lib/placeholder-cells.ts), a slice of rows at a
// time in storage order, but each row is checked against the rule first. A
// row that passes gets '⏳ Processing...' in every run column and is run; one
// that fails is never sent anywhere and gets "⏭️ Condition not met" in the
// run's main column (its other columns emptied), unless that cell holds a
// result from an earlier run (run-markers.ts takesConditionMark): paid-for
// values are never thrown away. Checked
// here, before ⏳ goes in, so a rule can read the run's own column ("only
// where Output is empty").
import { db } from './db';
import { jsonPath } from './sql-rows';
import { eachRowIdSlice, sheetRowIds } from './row-order';
import { PLACEHOLDER } from './placeholder-cells';
import { CONDITION_NOT_MET, isConditionNotMet, takesConditionMark } from './run-markers';
import { rulePasses, type RuleNode } from './run-condition';

export interface RuleSeed { tree: RuleNode; columns: string[]; markColumn: string }

// Returns how many rows the rule kept out, or null when the run was cancelled
// while starting (nothing more is written once `live` says so).
export async function seedPlaceholdersByRule(args: {
  sheetId: string; userId: string; columns: string[]; rule: RuleSeed;
  targets: number[] | null; lastRow: number; skip?: Set<number>; live: () => boolean;
}): Promise<{ notMet: number } | null> {
  const { sheetId, userId, columns, rule, live } = args;
  const paths = columns.map(jsonPath);
  const run = db.prepare(`UPDATE rows SET data = json_set(data${paths.map(() => `, ?, '${PLACEHOLDER}'`).join('')})
    WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?`);
  const others = columns.filter(c => c !== rule.markColumn).map(jsonPath);
  const keepOut = db.prepare(`UPDATE rows SET data = json_set(data, ?, ?${others.map(() => ", ?, ''").join('')})
    WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?`);
  const picks = rule.columns.map(() => ', json_extract(data, ?)').join('');
  const read = db.prepare(`SELECT rowid, row_index, json_extract(data, ?)${picks}
    FROM rows WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?`).raw();
  const readPaths = [jsonPath(rule.markColumn), ...rule.columns.map(jsonPath)];
  const skip = args.skip ?? new Set<number>();
  const rowIds = await sheetRowIds(sheetId, userId, args.targets ? { targets: args.targets } : { upTo: args.lastRow });
  let notMet = 0, stopped = false;
  await eachRowIdSlice(rowIds, ids => {
    if (!live()) { stopped = true; return false; }
    const pass: number[] = [], mark: number[] = [];
    for (const r of read.all(...readPaths, ids, sheetId, userId) as unknown[][]) {
      if (skip.has(r[1] as number)) continue;
      const values: Record<string, string> = {};
      rule.columns.forEach((c, i) => { values[c] = r[i + 3] == null ? '' : String(r[i + 3]); });
      if (rulePasses(rule.tree, values)) { pass.push(r[0] as number); continue; }
      notMet++;
      const main = r[2] == null ? '' : String(r[2]);
      // A row kept out already keeps its mark: no write (a big sheet's rule may keep most rows out).
      if (takesConditionMark(main) && !isConditionNotMet(main)) mark.push(r[0] as number);
    }
    if (pass.length) run.run(...paths, JSON.stringify(pass), sheetId, userId);
    if (mark.length) {
      keepOut.run(jsonPath(rule.markColumn), CONDITION_NOT_MET, ...others, JSON.stringify(mark), sheetId, userId);
    }
  });
  return stopped ? null : { notMet };
}
