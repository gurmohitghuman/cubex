// Over 200 lines: one step's life in the job thread (its names, the index, the waits, the match) holds together.
// Lookup steps of a waterfall run (free): the row's input matched against a
// column of another sheet (equals, or contains), and the value is the return
// column of the first matching row, top of that sheet first; no match, and the
// next step runs. That column is indexed as a lookup column's is
// (lookup_sources, services/lookup-maintain.ts): the step makes the index when
// there is none (no lookup column reads that column, or it was let go), only
// once that sheet lists the column in the same transaction, and while it builds
// or a sort's row positions are read again, brings it up to date itself in this
// job thread, one round at a time and one driver per sheet. Rows written there
// since are read into it just before matching, so an answer matches that sheet
// as it is then. It waits while that sheet moves its rows, or a run there is
// filling the cell it would return (services/waterfall-lookup-wait.ts): a miss
// would send the row on to the paid steps. The step's names are read again
// from the run's stored config at most once a second (a rename there rewrites
// it: lib/waterfall/lookup-refs.ts), and at once before a miss could come from
// a name that moved. A sheet or column that is gone pauses the run ('setup'),
// and so does a sheet in the trash; once it's restored, Resume goes on.
import { db } from '../lib/db';
import {
  LOOKUP_CACHE_ENTRIES, LOOKUP_CONTAINS_MIN_CHARS, LOOKUP_MAX_MATCHES, LOOKUP_STEP_MS, LOOKUP_STEP_ROUND_MS,
  LOOKUP_STEP_ROWS, LOOKUP_WAIT_POLL_MS,
} from '../lib/constants';
import { getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import { jsonPath } from '../lib/sql-rows';
import { holdsRunMarker, trimBlank } from '../lib/run-markers';
import { lookupValue } from '../lib/lookup/normalize';
import { normalizeResult } from '../lib/waterfall/result-type';
import { traceValue } from '../lib/waterfall/trace';
import {
  waterfallConfigOf, type LookupChoices, type WaterfallBlock, type WaterfallStep,
} from '../lib/waterfall/config';
import {
  ensureLookupSource, lookupSourceNearlyReady, lookupSourceOf, lookupSourceState, type LookupSource,
} from './lookup-source';
import { drainWithin, forgetBuildRows, maintainLookupSheet } from './lookup-maintain';
import { matchContains, matchEquals, type LookupMatches } from './lookup-probe';
import { cellStillFilling, otherSheetMoving } from './waterfall-lookup-wait';
import { lookedInSheet } from './waterfall-build-lookup';
import { noInputs, STOP, type StepResult, type StepRun } from './waterfall-step-types';

const TOO_SHORT = `Contains needs at least ${LOOKUP_CONTAINS_MIN_CHARS} characters`;
const TOO_MANY = `More than ${LOOKUP_MAX_MATCHES.toLocaleString('en-US')} rows match`;
const TOO_SLOW = 'Too slow to match by contains: use a longer value';
const FIRST = { kind: 'first', want: 1 } as const;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface OtherSheet { name: string | null; gone: string | null; columns: Set<string>; at: number }
type Found = { m: LookupMatches; raw: unknown };
interface Ask {
  w: WaterfallBlock; step: WaterfallStep; given: LookupChoices; inputs: Record<string, string>;
  halt: (message: string, reason?: string) => void;
}

// A cell of the other sheet as text: a run's own words read as empty.
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? trimBlank(v) : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return holdsRunMarker(s) ? '' : s;
}

const moved = (a: LookupChoices, b: LookupChoices): boolean =>
  a.sheetId !== b.sheetId || a.matchColumn !== b.matchColumn || a.returnColumn !== b.returnColumn;

export class RunLookups {
  private names = new Map<string, LookupChoices>();
  private namesAt = 0;
  private sheets = new Map<string, OtherSheet>();
  private driving = new Map<string, Promise<unknown>>();
  private cache = new Map<string, { token: string; matches: Map<string, LookupMatches> }>();

  constructor(private readonly runId: string, private readonly userId: string,
    private readonly stopped: () => boolean, private readonly autorun: boolean) {}

  // The step's names as the run's stored config holds them now (a rename in that sheet rewrites them).
  private choicesOf(step: WaterfallStep, given: LookupChoices, fresh: boolean): LookupChoices {
    if (fresh || Date.now() - this.namesAt >= 1000) {
      const raw = db.prepare('SELECT config FROM http_runs WHERE id = ? AND user_id = ?').pluck()
        .get(this.runId, this.userId) as string | undefined;
      const steps = waterfallConfigOf(raw)?.waterfall.steps ?? [];
      this.names = new Map(steps.flatMap(s => (s.choices.kind === 'lookup' ? [[s.id, s.choices]] : [])));
      this.namesAt = Date.now();
    }
    return this.names.get(step.id) ?? given;
  }

  private sheet(id: string, fresh: boolean): OtherSheet {
    const had = this.sheets.get(id);
    if (had && !fresh && Date.now() - had.at < 1000) return had;
    const sheet = lookedInSheet(id, this.userId);
    const name = 'name' in sheet ? sheet.name : null;
    const columns = new Set(name === null ? [] : getSheetColumns(id, this.userId, false));
    const now = { name, gone: 'gone' in sheet ? sheet.gone : null, columns, at: Date.now() };
    this.sheets.set(id, now);
    return now;
  }

  // Why the step can't look there any more, or null.
  private gone(c: LookupChoices, fresh: boolean): string | null {
    const other = this.sheet(c.sheetId, fresh);
    if (other.name === null) return other.gone;
    const col = [c.matchColumn, c.returnColumn].find(x => !other.columns.has(x));
    return col === undefined ? null : `the column "${col}" isn't in "${other.name}" any more`;
  }

  // The step's names now, or STOP once the run is paused because what they name
  // is gone. What was read up to a second ago is read again before pausing (a
  // rename may be half seen); `fresh` reads it all again at once.
  private current(a: Ask, fresh: boolean): LookupChoices | typeof STOP {
    let c = this.choicesOf(a.step, a.given, fresh);
    let gone = this.gone(c, fresh);
    if (gone && !fresh) {
      c = this.choicesOf(a.step, a.given, true);
      gone = this.gone(c, true);
    }
    if (!gone) return c;
    const fix = this.autorun ? 'Put it back, or edit the waterfall, then turn auto-run on again.'
      : 'Put it back and resume, or cancel and edit the waterfall.';
    a.halt(`Step "${a.step.label}": ${gone}. ${fix}`, 'setup');
    return STOP;
  }

  // A round of bringing the sheet's keys up to date, shared by the rows waiting on it.
  private maintain(sheetId: string): Promise<unknown> {
    let p = this.driving.get(sheetId);
    if (!p) {
      p = maintainLookupSheet(sheetId, this.userId, Date.now() + LOOKUP_STEP_ROUND_MS)
        .finally(() => this.driving.delete(sheetId));
      this.driving.set(sheetId, p);
    }
    return p;
  }

  // The index of the column it matches, made only while that sheet lists the
  // column, in the same transaction: a rename or delete there changes the list,
  // the indexes and the run's names at once, so no index is left on a name
  // that's gone. null: the names moved (read them again).
  private source(c: LookupChoices): LookupSource | null {
    const contains = c.mode === 'contains';
    const have = lookupSourceOf(c.sheetId, this.userId, c.matchColumn);
    if (have && (have.with_text === 1 || !contains)) return have;
    return db.transaction(() => {
      if (!verifySheetOwnership(c.sheetId, this.userId)
        || !getSheetColumns(c.sheetId, this.userId, false).includes(c.matchColumn)) return null;
      return ensureLookupSource(this.userId, c.sheetId, c.matchColumn, contains);
    }).immediate();
  }

  // The rows written there since are read into the index in a short write
  // transaction of their own, then the value is matched in a read transaction
  // (a row written in between is as if it came a moment later). null: the keys
  // aren't current yet.
  private match(stepId: string, c: LookupChoices, src: LookupSource, value: string): Found | null {
    if (lookupSourceState(src) === 'changed'
      && !db.transaction(() => drainWithin(c.sheetId, this.userId, LOOKUP_STEP_MS)).immediate()) return null;
    return db.transaction((): Found | null => {
      const state = lookupSourceState(src);
      if (state === 'building' || state === 'reordering') return null;
      const version = db.prepare('SELECT version FROM lookup_sources WHERE id = ?').pluck().get(src.id) as number;
      const token = `${src.id}:${version}:${c.mode}`;
      let kept = this.cache.get(stepId);
      if (!kept || kept.token !== token) {
        kept = { token, matches: new Map() };
        this.cache.set(stepId, kept);
      }
      let m = kept.matches.get(value);
      if (!m) {
        m = c.mode === 'equals' ? matchEquals(src.id, value, FIRST) : matchContains(src.id, value, FIRST);
        if (kept.matches.size >= LOOKUP_CACHE_ENTRIES) kept.matches.clear();
        kept.matches.set(value, m);
      }
      if (m.rids.length === 0) return { m, raw: null };
      const raw = db.prepare(`SELECT json_extract(data, ?) FROM rows WHERE rowid = ? AND +sheet_id = ?
        AND +user_id = ?`).pluck().get(jsonPath(c.returnColumn), m.rids[0], c.sheetId, this.userId);
      return { m, raw };
    })();
  }

  async run(a: Ask): Promise<StepResult> {
    let c = this.current(a, false);
    if (c === STOP) return STOP;
    const value = lookupValue(a.inputs[c.inputKey] ?? '');
    if (!value) return noInputs(`Needs ${c.inputKey}.`);
    for (;;) {
      if (this.stopped()) return STOP;
      if (otherSheetMoving(c.sheetId, this.userId)) { await pause(LOOKUP_WAIT_POLL_MS); continue; }
      const src = this.source(c);
      if (!src) {
        const now = this.current(a, true);
        if (now === STOP) return STOP;
        c = now;
        continue;
      }
      const state = lookupSourceState(src);
      const near = state === 'ready'
        || (state === 'changed' && lookupSourceNearlyReady(c.sheetId, this.userId, c.matchColumn, LOOKUP_STEP_ROWS));
      const found = near ? this.match(a.step.id, c, src, value) : null;
      if (!found) { await this.maintain(c.sheetId); continue; }
      if (found.m.rids.length > 0 && cellText(found.raw) === '') {
        // Its value there may still be coming, or the cell was read under a name that just moved.
        if (cellStillFilling(found.raw, c.sheetId, this.userId, c.returnColumn)) {
          await pause(LOOKUP_WAIT_POLL_MS);
          continue;
        }
        const now = this.current(a, true);
        if (now === STOP) return STOP;
        if (moved(now, c)) { c = now; continue; }
      }
      return this.outcome(a.w, found);
    }
  }

  // At the run's end: the row snapshots this thread kept while building (a later build reads them again).
  dispose(): void {
    forgetBuildRows();
    this.cache.clear();
  }

  private outcome(w: WaterfallBlock, f: Found): StepRun {
    const free = { costUsd: 0 } as const;
    if (f.m.tooShort) return { outcome: 'not_found', value: '', detail: TOO_SHORT, ...free };
    if (f.m.over) return { outcome: 'not_found', value: '', detail: TOO_MANY, ...free };
    if (f.m.tooSlow) return { outcome: 'error', value: '', detail: TOO_SLOW, ...free };
    if (f.m.rids.length === 0) return { outcome: 'not_found', value: '', ...free };
    const text = cellText(f.raw);
    const value = normalizeResult(w.resultType, text, w.phone);
    if (value) return { outcome: 'answered', value, ...free };
    if (text) return { outcome: 'not_found', value: '', got: traceValue(text), ...free };
    return { outcome: 'not_found', value: '', detail: 'The matching row has no value there.', ...free };
  }
}
