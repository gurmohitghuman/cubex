// The SQL functions compiled filters call (sql.ts), registered on every
// connection (lib/db.ts). SQLite's own lower() folds only ASCII letters, so
// "MÜNCHEN" wouldn't equal "münchen" in a filter while it does in an "Only run
// if" rule; these run the rules' own code instead. Deterministic and side-effect
// free; never used in the schema (trusted_schema is off).
import type { Database } from 'better-sqlite3';
import { asDate } from './dates';
import { asNumber, foldText } from './ops';

export function registerRowFilterFunctions(db: Database): void {
  db.function('cubex_fold', { deterministic: true }, (v: unknown) => foldText(v));
  db.function('cubex_num', { deterministic: true }, (v: unknown) => asNumber(v));
  db.function('cubex_date', { deterministic: true }, (v: unknown) => asDate(v));
}
